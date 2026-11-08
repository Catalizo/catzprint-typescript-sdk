// Regression tests for SDK addendum 4 (audit round 6): Q1–Q6.
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CatzPrint,
  NotFoundError,
  OutcomeUnknownError,
  type CatzPrint as Client,
  type StoredToken,
  type TokenStore,
} from "../../src/index.js";
import { CatzPrintLocal } from "../../src/local/browser.js";
import { cloudAmbiguous, cloudNotDelivered } from "../../src/local/manager.js";
import { boxKeyPair } from "../../src/nacl.js";
import { fakeCloud, fakeStation, localClient } from "./localHelpers.js";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function station() {
  const s = await fakeStation();
  cleanups.push(s.close);
  return s;
}
async function cloud(sequence: number[] = [], code = "duplicate") {
  const c = await fakeCloud();
  c.state.jobSequence = sequence;
  c.state.jobCode = code;
  cleanups.push(c.close);
  return c;
}
function client(...args: Parameters<typeof localClient>): Client {
  const c = localClient(...args);
  cleanups.push(() => c.close());
  return c;
}
const jobBodies = (c: Awaited<ReturnType<typeof cloud>>) => c.requests.filter((r) => r.method === "POST" && r.url.endsWith("/jobs")).map((r) => r.body);

/** A store that persists with JSON.stringify (like a Redis/DB store). */
class JsonStore implements TokenStore {
  readonly m = new Map<string, string>();
  async load(k: string): Promise<StoredToken | undefined> {
    const v = this.m.get(k);
    return v === undefined ? undefined : (JSON.parse(v) as StoredToken);
  }
  async save(k: string, t: StoredToken): Promise<void> {
    this.m.set(k, JSON.stringify(t));
  }
}

describe("Q1: 409 in_progress", () => {
  it("a POST answered in_progress is waited for by probing", async () => {
    const c = await cloud();
    const a = await station();
    const b = await station();
    a.postInProgress = true;
    const cz = client(c.url, { mode: "local_first", stations: [a.url, b.url], fingerprints: { [a.url]: a.fp, [b.url]: b.fp } });
    const j = await cz.jobs.create({ text: "x", idempotencyKey: "q1" });
    expect(j.local?.station_url).toBe(a.url);
    expect(b.jobRequests()).toHaveLength(0);
    expect(c.state.jobs).toHaveLength(0);
  });

  it("a probe that stays in_progress ends in OutcomeUnknown, never a fallback", async () => {
    const c = await cloud();
    const a = await station();
    const b = await station();
    a.postInProgress = true;
    a.probeAnswer = [409, "in_progress"];
    const cz = client(c.url, { mode: "local_first", stations: [a.url, b.url], fingerprints: { [a.url]: a.fp, [b.url]: b.fp } });
    await expect(cz.jobs.create({ text: "x" })).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(b.jobRequests()).toHaveLength(0);
    expect(c.state.jobs).toHaveLength(0);
  });

  it("browser: in_progress is probed", async () => {
    const A = "https://192-168-1-20.abcdefghij.local.catzprint.com:7443";
    const f = async (url: string, init: RequestInit): Promise<Response> => {
      if (init.method === "POST") return new Response(JSON.stringify({ error: { code: "in_progress", message: "x" } }), { status: 409 });
      return new Response(JSON.stringify({ id: "lj_9", status: "printed" }), { status: 200 });
    };
    const local = new CatzPrintLocal({ stations: [A], token: "t", fetch: f });
    expect(await local.print({ text: "x" })).toMatchObject({ id: "lj_9" });
  });
});

describe("Q2: tokens serialize, logs redact", () => {
  it("a JSON.stringify-based store keeps the real token across a restart", async () => {
    const c = await cloud();
    const st = await station();
    const store = new JsonStore();
    const opts = { mode: "local" as const, stations: [st.url], fingerprints: { [st.url]: st.fp }, tokenStore: store };
    await client(c.url, opts).jobs.create({ text: "1" });
    const first = st.jobRequests()[0]!.auth;
    c.state.down = true;
    await client(c.url, opts).jobs.create({ text: "2" });
    expect(st.jobRequests().at(-1)!.auth).toBe(first);
  });

  it("a stored placeholder counts as no token", async () => {
    const c = await cloud();
    const st = await station();
    const store = new JsonStore();
    const cz = client(c.url, { mode: "local", stations: [st.url], fingerprints: { [st.url]: st.fp }, tokenStore: store });
    // The store hands back a placeholder (a store that saved a redacted form).
    const realLoad = store.load.bind(store);
    store.load = async () => ({ token: "czl1.…", expires_at: new Date(Date.now() + 20 * 86_400_000).toISOString() });
    await cz.jobs.create({ text: "x" });
    store.load = realLoad;
    expect(st.jobRequests()[0]!.auth).not.toContain("…");
    expect(c.state.mints).toHaveLength(1);
    // S6 (addendum 5): the store error is cleared once the re-minted token was stored.
    expect(cz.local.storeError).toBeUndefined();
  });

  it("LocalToken / pairing results: JSON has the token, inspect and toString don't", async () => {
    const c = await cloud();
    const cz = client(c.url, {});
    const lt = await cz.localTokens.create({ deviceName: "Till" });
    expect(JSON.parse(JSON.stringify(lt)).token).toBe(lt.token);
    expect(inspect(lt)).not.toContain(lt.token);
    expect(inspect(lt)).toContain("czl1.…");
    expect(String(lt)).not.toContain(lt.token);
  });
});

describe("Q3 + Q4: build once, identical re-sends, cloud-mode create for non-local jobs", () => {
  for (const mode of ["cloud", "local_first", "cloud_first"] as const) {
    it(`${mode}: a sealed job's 409 re-sends carry the same bytes`, async () => {
      const c = await cloud([409, 409, 0]);
      c.state.serverKey = Buffer.from(boxKeyPair().publicKey).toString("base64");
      const st = await station();
      const cz = client(c.url, mode === "cloud" ? {} : { mode, stations: [st.url], fingerprints: { [st.url]: st.fp } });
      const j = await cz.jobs.create({ text: "card 4111", sealed: true });
      expect(j.id).toBe("cloud-3");
      const bodies = jobBodies(c);
      expect(bodies).toHaveLength(3);
      expect(new Set(bodies).size).toBe(1);
      expect(bodies[0]).toContain("sealed_content");
      expect(st.reqs).toHaveLength(0);
    });
  }

  it("cloud_first: the ambiguous retry re-sends the same bytes", async () => {
    const c = await cloud([500, 0], "internal");
    const st = await station();
    const cz = client(c.url, { mode: "cloud_first", stations: [st.url], fingerprints: { [st.url]: st.fp } });
    await cz.jobs.create({ text: "x", idempotencyKey: "q3" });
    const bodies = jobBodies(c);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it("local_first: a PDF gets the cloud-mode 409 loop", async () => {
    const c = await cloud([409, 0]);
    const st = await station();
    const cz = client(c.url, { mode: "local_first", stations: [st.url], fingerprints: { [st.url]: st.fp } });
    const j = await cz.printPdf(new Uint8Array(Buffer.from("%PDF-1.4 x")));
    expect(j.id).toBe("cloud-2");
    expect(st.reqs).toHaveLength(0);
  });
});

it("Q5: browser retries the /info preflight within the probe budget", async () => {
  const A = "https://192-168-1-20.abcdefghij.local.catzprint.com:7443";
  const B = "https://192-168-1-21.abcdefghij.local.catzprint.com:7443";
  let infos = 0;
  let warm = true;
  const posted: string[] = [];
  const f = async (url: string, init: RequestInit): Promise<Response> => {
    if (warm) return new Response("{}", { status: 200 });
    if (init.method === "POST") {
      posted.push(url.startsWith(A) ? "A" : "B");
      if (url.startsWith(A)) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ id: "lj_b" }), { status: 201 });
    }
    if (url.endsWith("/info")) {
      if (++infos < 3) throw new TypeError("Failed to fetch"); // A is back after a moment
      return new Response("{}", { status: 200 });
    }
    return new Response(JSON.stringify({ id: "lj_a", status: "queued" }), { status: 200 }); // probe: A has it
  };
  const local = new CatzPrintLocal({ stations: [A, B], token: "t", fetch: f });
  // S3 (addendum 5): the long /info retry is only for a station that has
  // answered before in this client's lifetime (but not in the last 30 s).
  await local.info(A);
  warm = false;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + 31_000);
  try {
    expect(await local.print({ text: "x", idempotencyKey: "q5" })).toMatchObject({ id: "lj_a", station_url: A });
  } finally {
    vi.restoreAllMocks();
  }
  expect(infos).toBe(3);
  expect(posted).toEqual(["A"]);
});

it("Q6: a failed server-key fetch before the POST is not delivered", async () => {
  const c = await cloud(); // no server key: 404
  const cz = new CatzPrint({ apiKey: "cz_test_x", baseUrl: c.url, orgId: "34c4671b-d2ab-4ddf-aaac-615786d5acac", maxRetries: 0 });
  cleanups.push(() => cz.close());
  const err = await cz.jobs.prepareCloud({ text: "x", sealed: true }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(NotFoundError);
  expect(cloudNotDelivered(err)).toBe(true);
  expect(cloudAmbiguous(err)).toBe(false);
  expect(jobBodies(c)).toHaveLength(0);
});
