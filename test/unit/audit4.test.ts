// Regression tests for SDK addendum 2 (audit round 4): the auditor's proofs
// (scratchpad/audit4/sdk/node/test/audit4) as assertions, plus one test per
// SDK-1 branch and the other items.
import { chmodSync, chownSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CatzPrint,
  ConnectionError,
  FileTokenStore,
  InsecureTokenStoreError,
  OutcomeUnknownError,
  ServerError,
  StationUnreachableError,
  ValidationError,
  isOutcomeUnknown,
  type CatzPrint as Client,
} from "../../src/index.js";
import { CatzPrintLocal } from "../../src/local/browser.js";
import { dashedIp } from "../../src/local/transport.js";
import { sealBox } from "../../src/nacl.js";
import { apiError, fakeApi, job, KEY, ORG, send } from "./helpers.js";
import { DEAD_CLOUD, deadUrl, fakeCloud, fakeStation, localClient } from "./localHelpers.js";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function station() {
  const s = await fakeStation();
  cleanups.push(s.close);
  return s;
}
async function cloud() {
  const c = await fakeCloud();
  cleanups.push(c.close);
  return c;
}
function client(...args: Parameters<typeof localClient>): Client {
  const c = localClient(...args);
  cleanups.push(() => c.close());
  return c;
}
async function twoStations(mode: "local" | "local_first") {
  const c = await cloud();
  const a = await station();
  const b = await station();
  const cz = client(c.url, { mode, stations: [a.url, b.url], fingerprints: { [a.url]: a.fp, [b.url]: b.fp }, requestTimeoutMs: 300 });
  return { c, a, b, cz };
}

describe("SDK-1: never double-print on an ambiguous outcome (stations)", () => {
  it("auditor's proof: a late answer is not re-sent to the next station → OutcomeUnknown", async () => {
    const { a, b, cz } = await twoStations("local");
    a.delayMs = 2000; // got the job, answers late; the probe is slow too
    const err = (await cz.jobs.create({ text: "x", idempotencyKey: "order-7" }).catch((e: unknown) => e)) as OutcomeUnknownError;
    expect(err).toBeInstanceOf(OutcomeUnknownError);
    expect(isOutcomeUnknown(err)).toBe(true);
    expect(err).toMatchObject({ code: "outcome_unknown", url: a.url, idempotencyKey: "order-7" });
    expect(err.message).toBe("The station may have printed this job. Retry later with the same idempotency key.");
    expect(b.jobRequests()).toHaveLength(0);
  });

  it("not delivered (502) → next station", async () => {
    const { a, b, cz } = await twoStations("local");
    a.fail = (p) => (p === "/local/v1/jobs" ? [502, "bad_gateway"] : undefined);
    expect((await cz.jobs.create({ text: "x" })).local?.station_url).toBe(b.url);
  });

  it("delivered, answer lost, the station has it by key → that job", async () => {
    const { c, a, b, cz } = await twoStations("local_first");
    a.answerDelayMs = 2000;
    const j = await cz.jobs.create({ text: "x", idempotencyKey: "order-8" });
    expect(j).toMatchObject({ via: "local", idempotency_key: "order-8" });
    expect(j.local?.station_url).toBe(a.url);
    expect(a.jobRequests()).toHaveLength(1);
    expect(a.reqs.some((r) => r.method === "GET" && r.query === "idempotency_key=order-8")).toBe(true);
    expect(b.jobRequests()).toHaveLength(0);
    expect(c.state.jobs).toHaveLength(0);
  });

  it("delivered, the station never recorded it (404) → next station", async () => {
    const { a, b, cz } = await twoStations("local");
    a.jobDelayMs = 2000;
    expect((await cz.jobs.create({ text: "x" })).local?.station_url).toBe(b.url);
  });

  it("delivered, no answer at all → OutcomeUnknown, no cloud fallback", async () => {
    const { c, a, b, cz } = await twoStations("local_first");
    a.delayMs = 2000;
    await expect(cz.jobs.create({ text: "x" })).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(c.state.jobs).toHaveLength(0);
    expect(b.jobRequests()).toHaveLength(0);
  });
});

describe("SDK-1: cloud attempts", () => {
  it("500 once → one retry with the same key", async () => {
    const c = await cloud();
    Object.assign(c.state, { jobStatus: 500, jobCode: "internal", jobFailures: 1 });
    const st = await station();
    const cz = client(c.url, { mode: "cloud_first", stations: [st.url], fingerprints: { [st.url]: st.fp } });
    const j = await cz.jobs.create({ text: "x", idempotencyKey: "k1" });
    expect(j.via).toBe("cloud");
    expect(c.state.jobs.map((x) => x.idempotency_key)).toEqual(["k1", "k1"]);
    expect(st.reqs).toHaveLength(0);
  });

  for (const mode of ["cloud_first", "local_first"] as const) {
    it(`${mode}: 500 twice → OutcomeUnknown, never local`, async () => {
      const c = await cloud();
      Object.assign(c.state, { jobStatus: 500, jobCode: "internal" });
      const st = await station();
      const urls = mode === "local_first" ? [await deadUrl()] : [st.url];
      const cz = client(c.url, { mode, stations: urls, fingerprints: { [urls[0]!]: st.fp } });
      const err = (await cz.jobs.create({ text: "x" }).catch((e: unknown) => e)) as OutcomeUnknownError;
      expect(err).toBeInstanceOf(OutcomeUnknownError);
      expect(err.cause).toBeInstanceOf(ServerError);
      expect(c.state.jobs).toHaveLength(2);
      expect(st.reqs).toHaveLength(0);
    });
  }

  it("connection dropped after the request → one retry, then OutcomeUnknown", async () => {
    const c = await cloud();
    c.state.hangup = true;
    const st = await station();
    const cz = client(c.url, { mode: "cloud_first", stations: [st.url], fingerprints: { [st.url]: st.fp } });
    const err = (await cz.jobs.create({ text: "x" }).catch((e: unknown) => e)) as OutcomeUnknownError;
    expect(err).toBeInstanceOf(OutcomeUnknownError);
    expect(err.cause).toBeInstanceOf(ConnectionError);
    expect((err.cause as ConnectionError).delivered).toBe(true);
    expect(c.state.jobs).toHaveLength(2);
    expect(st.reqs).toHaveLength(0);
  });

  it("not delivered (connection refused) → local", async () => {
    const st = await station();
    const cz = client(DEAD_CLOUD, { mode: "cloud_first", stations: [st.url], fingerprints: { [st.url]: st.fp }, token: "czd_x" });
    expect((await cz.jobs.create({ text: "x" })).via).toBe("local");
  });
});

describe("SDK-2: idempotency keys", () => {
  it("auditor's proof: '' in cloud mode → one generated key reused across retries", async () => {
    const api = await fakeApi((req, res, n) => {
      if (n <= 2) return apiError(res, 503, "server_error", "busy");
      send(res, 201, { job: job() });
    });
    cleanups.push(api.close);
    const cz = new CatzPrint({ apiKey: KEY, baseUrl: api.url, orgId: ORG });
    await cz.jobs.create({ text: "hi", idempotencyKey: "" });
    const keys = api.requests.filter((r) => r.method === "POST").map((p) => p.json.idempotency_key);
    expect(keys.length).toBe(3);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("auditor's proof: browser print('') sends one sdk- key to the station and the fallback", async () => {
    let fbKey: string | undefined;
    const bodies: any[] = [];
    const local = new CatzPrintLocal({
      stations: ["https://192-168-1-20.lbl.local.catzprint.com:7443"],
      token: "czd_x",
      fetch: async (_u, init) => {
        bodies.push(JSON.parse(String(init.body)));
        throw new TypeError("fetch failed");
      },
      fallback: async (p) => {
        fbKey = p.idempotencyKey;
        return {} as any;
      },
    });
    await local.print({ text: "hi", idempotencyKey: "  " });
    expect(bodies[0].idempotency_key).toMatch(/^sdk-/);
    expect(fbKey).toBe(bodies[0].idempotency_key);
    await expect(local.print({ text: "hi", idempotencyKey: " k" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("local: blank → sdk- key; padded or control characters refused, nothing sent", async () => {
    const st = await station();
    const cz = client(DEAD_CLOUD, { mode: "local", stations: [st.url], fingerprints: { [st.url]: st.fp }, token: "czd_x" });
    await cz.jobs.create({ text: "x", idempotencyKey: "\t" });
    expect(st.jobRequests()[0]!.body.idempotency_key).toMatch(/^sdk-/);
    for (const bad of [" order-1", "order-1 ", "order\n1", "a\u0000b"]) {
      await expect(cz.jobs.create({ text: "x", idempotencyKey: bad })).rejects.toMatchObject({ code: "invalid", fields: { idempotency_key: expect.any(String) } });
    }
    expect(st.jobRequests()).toHaveLength(1);
  });
});

describe("SDK-3: small-order keys", () => {
  it("auditor's proof: sealBox refuses a small-order key; the server key check too", async () => {
    const pk = new Uint8Array(32);
    pk[0] = 1;
    expect(() => sealBox(new TextEncoder().encode("x"), pk)).toThrow(/small-order/);
    const api = await fakeApi((_r, res) => send(res, 200, { public_key: Buffer.from(pk).toString("base64"), algorithm: "x25519" }));
    cleanups.push(api.close);
    const cz = new CatzPrint({ apiKey: KEY, baseUrl: api.url, orgId: ORG });
    await expect(cz.serverPublicKey()).rejects.toThrow(/malformed/);
    const good = new Uint8Array(32);
    good[0] = 9;
    expect(sealBox(new Uint8Array([1]), good).length).toBe(49);
  });
});

describe("SDK-4: secrets stay out of output", () => {
  it("tokens are readable but never in console.log / JSON.stringify / errors", async () => {
    const c = await cloud();
    const st = await station();
    st.accept = () => false;
    st.rejectCode = "device_revoked";
    const cz = client(c.url, { mode: "local_first", stations: [st.url], fingerprints: { [st.url]: st.fp }, token: "czd_SECRETDEVICE" });
    const lt = await cz.localTokens.create({ deviceName: "Till" });
    expect(lt.token).toMatch(/^czl1\./);
    const err = await cz.jobs.create({ text: "x" }).then(() => undefined, (e: unknown) => e);
    // Q2 (addendum 4): results serialize WITH the token (backends hand it to tills);
    // logs, inspect, toString and errors never show it.
    expect(JSON.parse(JSON.stringify(lt)).token).toBe(lt.token);
    for (const out of [inspect(lt), String(lt), JSON.stringify(cz), inspect(cz), inspect(cz.local), JSON.stringify(cz.local), inspect(err, { depth: 6 }), String(err)]) {
      expect(out).not.toContain("SECRETDEVICE");
      expect(out).not.toContain(lt.token);
    }
    const browser = new CatzPrintLocal({ stations: ["https://a.b.c:7443"], token: "czd_SECRETBROWSER" });
    expect(JSON.stringify(browser) + inspect(browser)).not.toContain("SECRETBROWSER");
  });
});

describe("SDK-5: oversized station answers", () => {
  it("a job answer over 4 MiB is ambiguous: no next station, no fallback", async () => {
    const { c, a, b, cz } = await twoStations("local_first");
    a.huge = true;
    const err = (await cz.jobs.create({ text: "x" }).catch((e: unknown) => e)) as OutcomeUnknownError;
    expect(err).toBeInstanceOf(OutcomeUnknownError);
    expect((err.cause as { code?: string }).code).toBe("response_too_large");
    expect(b.reqs).toHaveLength(0);
    expect(c.state.jobs).toHaveLength(0);
  });

  it("a status answer over 4 MiB → response_too_large", async () => {
    const { a, b, cz } = await twoStations("local");
    a.huge = true;
    await expect(cz.local.status()).rejects.toMatchObject({ code: "response_too_large" });
    expect(b.reqs).toHaveLength(0);
  });

  it("browser: a body over 4 MiB is capped (also on a teed body)", async () => {
    const teed = new Response(JSON.stringify("a".repeat(5 * 1024 * 1024)), { status: 200 });
    const l0 = new CatzPrintLocal({ stations: ["https://a.b.c:7443"], token: "t", fetch: async () => teed.clone() });
    await expect(l0.status()).rejects.toMatchObject({ code: "response_too_large" });
    const body = JSON.stringify("a".repeat(5 * 1024 * 1024));
    const local = new CatzPrintLocal({ stations: ["https://a.b.c:7443"], token: "t", fetch: async () => new Response(body, { status: 200 }) });
    await expect(local.status()).rejects.toMatchObject({ code: "response_too_large" });
  });
});

describe("SDK-6: refresh threshold", () => {
  it("auditor's proof: a 3-day token isn't minted on every job", async () => {
    const c = await cloud();
    c.state.expiresInMs = 3 * 86_400_000;
    const st = await station();
    const cz = client(c.url, { mode: "local", tokenTtlDays: 3, stations: [st.url], fingerprints: { [st.url]: st.fp } });
    for (let i = 0; i < 10; i++) {
      await cz.jobs.create({ text: "x" });
      await cz.local.idle();
    }
    expect(c.state.mints).toHaveLength(1);
    const day = 86_400_000;
    expect(cz.local.refreshBefore({ issued_at: new Date(0).toISOString(), expires_at: new Date(3 * day).toISOString() })).toBe(1.5 * day);
    expect(cz.local.refreshBefore({ issued_at: new Date(0).toISOString(), expires_at: new Date(30 * day).toISOString() })).toBe(7 * day);
  });
});

describe("SDK-8: insecure token store", () => {
  it.skipIf(process.platform === "win32")("refuses a group/world-writable or foreign-owned store", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "cz-perm-")), "shared");
    mkdirSync(dir, { mode: 0o700 });
    const path = join(dir, "tokens.json");
    const s = new FileTokenStore(path);
    await s.save("k", { token: "czl1.a" });
    chmodSync(path, 0o666);
    await expect(s.load("k")).rejects.toBeInstanceOf(InsecureTokenStoreError);
    chmodSync(path, 0o600);
    chmodSync(dir, 0o777);
    await expect(s.load("k")).rejects.toBeInstanceOf(InsecureTokenStoreError);
    await expect(s.save("k", { token: "czl1.b" })).rejects.toBeInstanceOf(InsecureTokenStoreError);

    const c = await cloud();
    const st = await station();
    const cz = client(c.url, { mode: "local_first", stations: [st.url], fingerprints: { [st.url]: st.fp }, tokenStore: s });
    await expect(cz.jobs.create({ text: "x" })).rejects.toBeInstanceOf(InsecureTokenStoreError);
    expect(st.reqs).toHaveLength(0);
    chmodSync(dir, 0o700);
    if (process.getuid?.() === 0) {
      chownSync(path, 1017, 1017);
      await expect(s.load("k")).rejects.toBeInstanceOf(InsecureTokenStoreError);
    }
  });
});

describe("SDK-9: dashedIp", () => {
  it("rejects leading-zero octets", () => {
    expect(dashedIp("192-168-01-20.lbl.local.catzprint.com", "lbl")).toBeUndefined();
    expect(dashedIp("010-0-0-5.lbl.x", "lbl")).toBeUndefined();
    expect(dashedIp("10-0-0-5.lbl.x", "lbl")).toBe("10.0.0.5");
    expect(dashedIp("192-168-0-20.lbl.x", "lbl")).toBe("192.168.0.20");
  });
});

it("StationUnreachableError still carries the cloud error when the cloud refused delivery", async () => {
  const c = await cloud();
  Object.assign(c.state, { jobStatus: 503, jobCode: "unavailable" });
  const cz = client(c.url, { mode: "local_first", stations: [await deadUrl()], fingerprints: { "127.0.0.1": "ab".repeat(32) } });
  const err = (await cz.jobs.create({ text: "x" }).catch((e: unknown) => e)) as StationUnreachableError;
  expect(err).toBeInstanceOf(StationUnreachableError);
  expect(err.cloudError).toBeInstanceOf(ServerError);
  expect(c.state.jobs).toHaveLength(1);
});
