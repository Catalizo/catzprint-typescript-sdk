// Regression tests for SDK addendum 3 (audit round 5): the auditor's proofs
// (scratchpad/audit5/sdk/node/test/unit/audit5) as assertions, plus R1, R3,
// R4 and C1–C6.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CatzPrint,
  ConflictError,
  MemoryTokenStore,
  OutcomeUnknownError,
  StationUnreachableError,
  ValidationError,
  type CatzPrint as Client,
} from "../../src/index.js";
import { CatzPrintLocal } from "../../src/local/browser.js";
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
async function cloud(sequence: number[] = [], code = "x") {
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
async function twoStations(mode: "local" | "local_first") {
  const c = await cloud();
  const a = await station();
  const b = await station();
  const cz = client(c.url, { mode, stations: [a.url, b.url], fingerprints: { [a.url]: a.fp, [b.url]: b.fp }, requestTimeoutMs: 300 });
  return { c, a, b, cz };
}

const A = "https://192-168-1-20.abcdefghij.local.catzprint.com:7443";
const B = "https://192-168-1-21.abcdefghij.local.catzprint.com:7443";

describe("R1: an ambiguous cloud attempt never goes local", () => {
  for (const second of [503, 502]) {
    it(`cloud_first: 500 then ${second} → OutcomeUnknown`, async () => {
      const c = await cloud([500, second], "internal");
      const st = await station();
      const cz = client(c.url, { mode: "cloud_first", stations: [st.url], fingerprints: { [st.url]: st.fp } });
      await expect(cz.jobs.create({ text: "x", idempotencyKey: "order-1-kitchen-r1" })).rejects.toBeInstanceOf(OutcomeUnknownError);
      expect(c.state.jobs).toHaveLength(2);
      expect(st.reqs).toHaveLength(0);
    });
  }
  it("local_first: the OutcomeUnknown itself, not StationUnreachable", async () => {
    const c = await cloud([500, 503]);
    const dead = await deadUrl();
    const cz = client(c.url, { mode: "local_first", stations: [dead], fingerprints: { [dead]: "ab".repeat(32) } });
    const err = await cz.jobs.create({ text: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutcomeUnknownError);
    expect(err).not.toBeInstanceOf(StationUnreachableError);
  });
});

describe("R2: browser, reset after delivery", () => {
  it("auditor's proof: a station that answered recently is probed, not skipped", async () => {
    const printed: string[] = [];
    const f = async (url: string, init: RequestInit): Promise<Response> => {
      if (init.method === "POST") {
        printed.push(url.startsWith(A) ? "A" : "B");
        if (url.startsWith(A)) throw new TypeError("Failed to fetch"); // A got it, answer lost
      }
      if (init.method === "GET" && url.includes("idempotency_key")) {
        return new Response(JSON.stringify({ id: "lj_1", status: "queued" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "lj_2", status: "queued", unsynced: 0 }), { status: url.endsWith("/status") ? 200 : 201 });
    };
    const local = new CatzPrintLocal({ stations: [A, B], token: "czd_t", fetch: f });
    await local.status(); // A answered just now
    const job = await local.print({ text: "x", idempotencyKey: "order-1-kitchen-r1" });
    expect(printed).toEqual(["A"]);
    expect(job).toMatchObject({ id: "lj_1", station_url: A });
  });

  it("a quick /info preflight decides when there is no recent answer", async () => {
    const calls: string[] = [];
    const reachable = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push(`${init.method} ${url.replace(/^https:\/\/[^/]+/, "")}`);
      if (init.method === "POST" && url.startsWith(A)) throw new TypeError("Failed to fetch");
      if (url.endsWith("/info")) return new Response("{}", { status: 200 });
      if (url.includes("idempotency_key")) return new Response(JSON.stringify({ error: { code: "not_found", message: "x" } }), { status: 404 });
      return new Response(JSON.stringify({ id: "lj_2", status: "queued" }), { status: 201 });
    };
    const local = new CatzPrintLocal({ stations: [A, B], token: "czd_t", fetch: reachable });
    expect(await local.print({ text: "x" })).toMatchObject({ station_url: B }); // probed A: 404 → next
    expect(calls).toContain("GET /local/v1/info");

    // Down: the preflight fails too → not delivered → next station, no probe.
    const down = async (url: string, init: RequestInit): Promise<Response> => {
      if (url.startsWith(A)) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ id: "lj_3", status: "queued" }), { status: 201 });
    };
    const l2 = new CatzPrintLocal({ stations: [A, B], token: "czd_t", fetch: down });
    expect(await l2.print({ text: "x" })).toMatchObject({ id: "lj_3", station_url: B });
  });
});

describe("R3: probe answers", () => {
  it("409 duplicate is returned (no next station, no fallback)", async () => {
    const { c, a, b, cz } = await twoStations("local_first");
    a.answerDelayMs = 2000;
    a.probeAnswer = [409, "duplicate"];
    const err = await cz.jobs.create({ text: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).code).toBe("duplicate");
    expect(b.jobRequests()).toHaveLength(0);
    expect(c.state.jobs).toHaveLength(0);
  });

  it("only 404 not_found means never recorded; another 404 keeps probing", async () => {
    const { a, b, cz } = await twoStations("local");
    a.answerDelayMs = 2000;
    a.probeAnswer = [404, "no_such_route"];
    await expect(cz.jobs.create({ text: "x" })).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(b.jobRequests()).toHaveLength(0);
  });

  it("browser: 409 duplicate from the probe is thrown, fallback not called", async () => {
    let fell = false;
    const f = async (url: string, init: RequestInit): Promise<Response> => {
      if (init.method === "POST") return new Promise<Response>((_r, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      return new Response(JSON.stringify({ error: { code: "duplicate", message: "x" } }), { status: 409 });
    };
    const local = new CatzPrintLocal({ stations: [A, B], token: "t", fetch: f, timeoutMs: 50, fallback: async () => { fell = true; return null; } });
    await expect(local.print({ text: "x" })).rejects.toMatchObject({ code: "duplicate", status: 409 });
    expect(fell).toBe(false);
  });
});

describe("R4: cloud 409 duplicate / being created", () => {
  it("re-sends until created", async () => {
    const c = await cloud([409, 409, 0], "duplicate");
    const st = await station();
    const cz = client(c.url, { mode: "cloud_first", stations: [st.url], fingerprints: { [st.url]: st.fp } });
    const j = await cz.jobs.create({ text: "x", idempotencyKey: "k" });
    expect(j.id).toBe("cloud-3");
    expect(c.state.jobs.map((x) => x.idempotency_key)).toEqual(["k", "k", "k"]);
    expect(st.reqs).toHaveLength(0);
  });

  it("still 409 after 3 re-sends → that 409 (a definite answer), never local", async () => {
    const c = await cloud([500, 409], "duplicate");
    const st = await station();
    const cz = client(c.url, { mode: "cloud_first", stations: [st.url], fingerprints: { [st.url]: st.fp } });
    const err = await cz.jobs.create({ text: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(c.state.jobs).toHaveLength(5);
    expect(st.reqs).toHaveLength(0);
  });

  it("a re-send that isn't answered → OutcomeUnknown", async () => {
    const c = await cloud([409, 500], "duplicate");
    const st = await station();
    const cz = client(c.url, { mode: "cloud_first", stations: [st.url], fingerprints: { [st.url]: st.fp } });
    await expect(cz.jobs.create({ text: "x" })).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(c.state.jobs).toHaveLength(2);
    expect(st.reqs).toHaveLength(0);
  });

  it("cloud mode: the generated key is fixed before the first send", async () => {
    const c = await cloud([409, 0], "duplicate");
    const cz = client(c.url, {});
    const j = await cz.jobs.create({ text: "x" });
    expect(j.id).toBe("cloud-2");
    const keys = c.state.jobs.map((x) => x.idempotency_key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

it("C1: local_first returns the cloud's 4xx itself", async () => {
  const c = await cloud([422], "no_printer");
  const dead = await deadUrl();
  const cz = client(c.url, { mode: "local_first", stations: [dead], fingerprints: { [dead]: "ab".repeat(32) } });
  const err = await cz.jobs.create({ text: "x" }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect(err).not.toBeInstanceOf(StationUnreachableError);
});

it("C2: any 5xx but 502/503/504 is ambiguous (one retry)", async () => {
  const c = await cloud([501, 0]);
  const st = await station();
  const cz = client(c.url, { mode: "cloud_first", stations: [st.url], fingerprints: { [st.url]: st.fp } });
  expect((await cz.jobs.create({ text: "x" })).via).toBe("cloud");
  expect(c.state.jobs).toHaveLength(2);
});

it("C3: the org lookup failing before the job POST → not delivered → local", async () => {
  const srv = createServer((_req, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "internal", message: "x" } }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
  const st = await station();
  const cz = new CatzPrint({
    apiKey: "cz_test_x", baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, maxRetries: 0,
    local: { mode: "cloud_first", stations: [st.url], fingerprints: { [st.url]: st.fp }, token: "czd_x" },
  });
  cleanups.push(() => cz.close());
  expect((await cz.jobs.create({ text: "x" })).via).toBe("local");
});

it("C5: a 2xx without a usable job is probed by key", async () => {
  const { a, b, cz } = await twoStations("local");
  a.emptyAnswer = true;
  const j = await cz.jobs.create({ text: "x", idempotencyKey: "k5" });
  expect(j.id).toMatch(/^lj_/);
  expect(j.local?.station_url).toBe(a.url);
  expect(b.jobRequests()).toHaveLength(0);
});

describe("C6: cancellation", () => {
  it("after the write → OutcomeUnknown wrapping it; before → the cancellation", async () => {
    const { c, a, b, cz } = await twoStations("local_first");
    a.answerDelayMs = 3000;
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error("user cancelled")), 150);
    const err = (await cz.jobs.create({ text: "x", signal: ctrl.signal }).catch((e: unknown) => e)) as OutcomeUnknownError;
    expect(err).toBeInstanceOf(OutcomeUnknownError);
    expect((err.cause as Error).message).toBe("user cancelled");
    expect(b.jobRequests()).toHaveLength(0);
    expect(c.state.jobs).toHaveLength(0);
    const pre = new AbortController();
    pre.abort(new Error("early"));
    await expect(cz.jobs.create({ text: "x", signal: pre.signal })).rejects.toThrow("early");
  });

  it("cloud leg: cancelled while the cloud holds the answer → OutcomeUnknown", async () => {
    const srv = createServer((req, res) => {
      req.resume();
      req.on("end", () => setTimeout(() => res.destroyed || res.end("{}"), 3000).unref());
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }));
    const st = await station();
    const cz = client(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, { mode: "cloud_first", stations: [st.url], fingerprints: { [st.url]: st.fp } });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error("stop")), 200);
    await expect(cz.jobs.create({ text: "x", signal: ctrl.signal })).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(st.reqs).toHaveLength(0);
  });
});

it("auditor's proof: no token or API key in inspect/JSON of the client and local state", async () => {
  const store = new MemoryTokenStore();
  await store.save("k", { token: "czl1.SECRETTOKEN.sig", token_id: "t", expires_at: "2099-01-01T00:00:00Z" });
  const cz = new CatzPrint({
    apiKey: "cz_test_SECRETAPIKEY123456",
    local: { mode: "local_first", token: "czd_SECRETDEVICE", tokenStore: store, stations: ["https://10.0.0.1:7443"] },
  });
  cleanups.push(() => cz.close());
  for (const o of [inspect(cz, { depth: 20 }), inspect(cz.local, { depth: 20 }), JSON.stringify(cz), JSON.stringify(cz.local)]) {
    expect(o).not.toMatch(/SECRET/);
  }
});

void DEAD_CLOUD;
