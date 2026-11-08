// Regression tests for SDK addendum 6 (audit round 8): T1 (browser: a station
// whose print failed with a network error always gets one /info try; the shared
// budget only limits extra tries and only counts /info time; the auditor's
// browser_budget.mjs PoC) and T2 (once any answer said in_progress, a later
// probe 404 is OutcomeUnknown: the dip404 matrix scenario).
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutcomeUnknownError } from "../../src/index.js";
import { CatzPrintLocal } from "../../src/local/browser.js";
import { fakeCloud, fakeStation, localClient } from "./localHelpers.js";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
});

const A = "https://a.example:7443";
const B = "https://b.example:7443";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (status: number, o: unknown) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

/** The PoC's stations: A is down; B records the POST, then resets after `bPostDelay`. */
function budgetFetch(bPostDelay: number) {
  const log: string[] = [];
  const state = { aUp: false, bRecorded: false };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const p = u.pathname + u.search;
    log.push(`${u.origin === A ? "A" : "B"} ${init.method} ${p}`);
    if (u.origin === A) {
      if (state.aUp) return json(200, { station_id: "a" });
      throw new TypeError("Failed to fetch");
    }
    if (init.method === "POST") {
      state.bRecorded = true;
      await sleep(bPostDelay);
      throw new TypeError("Failed to fetch"); // reset after delivery
    }
    if (p.startsWith("/local/v1/info")) return json(200, { station_id: "b" });
    if (p.startsWith("/local/v1/jobs?")) return state.bRecorded ? json(200, { id: "lj_1", status: "queued" }) : json(404, { error: { code: "not_found", message: "x" } });
    return json(404, {});
  };
  return { fetch, log, state };
}

describe("T1: browser /info tries after a network error", () => {
  it("A refused, B delivered then reset after 5.2 s: B is still asked and its job returned", { timeout: 20_000 }, async () => {
    const { fetch, log } = budgetFetch(5_200);
    let fellBack = false;
    const c = new CatzPrintLocal({ stations: [A, B], token: "czl1.eyJ2IjoxfQ.c2ln", fetch, fallback: async () => ((fellBack = true), { id: "cloud" }) });
    const r = await c.print({ text: "x", idempotencyKey: "k1" });
    expect(r).toMatchObject({ id: "lj_1", station_url: B });
    expect(fellBack).toBe(false);
    expect(log.filter((l) => l.startsWith("B GET /local/v1/info")).length).toBeGreaterThanOrEqual(1);
    expect(log.filter((l) => l.startsWith("B GET /local/v1/jobs?")).length).toBeGreaterThanOrEqual(1);
  });

  it("A known (answered 60 s ago) and down eats the budget, B reset at once: B still gets its /info try", { timeout: 20_000 }, async () => {
    const { fetch, log, state } = budgetFetch(10);
    let fellBack = false;
    const c = new CatzPrintLocal({ stations: [A, B], token: "czl1.eyJ2IjoxfQ.c2ln", fetch, fallback: async () => ((fellBack = true), { id: "cloud" }) });
    state.aUp = true;
    await c.info(A);
    state.aUp = false;
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 60_000);
    const r = await c.print({ text: "x", idempotencyKey: "k2" });
    expect(r).toMatchObject({ id: "lj_1", station_url: B });
    expect(fellBack).toBe(false);
    expect(log.filter((l) => l.startsWith("A GET /local/v1/info")).length).toBeGreaterThan(2); // A used the budget
    expect(log.filter((l) => l.startsWith("B GET /local/v1/info")).length).toBeGreaterThanOrEqual(1);
    expect(log.filter((l) => l.startsWith("B GET /local/v1/jobs?")).length).toBeGreaterThanOrEqual(1);
  });
});

describe("T2: in_progress, then 404 → OutcomeUnknown", () => {
  for (const mode of ["local", "local_first"] as const) {
    it(`${mode}: dip404`, async () => {
      // Before: the 404 counted as "never recorded": next station / cloud.
      const c = await fakeCloud();
      cleanups.push(c.close);
      const a = await fakeStation();
      const b = await fakeStation();
      cleanups.push(a.close, b.close);
      a.jobDelayMs = 3_000; // the client gives up before the station records it
      let probes = 0;
      a.fail = (path, method) => (method === "GET" && path === "/local/v1/jobs" && ++probes === 1 ? [409, "in_progress"] : undefined);
      const cz = localClient(c.url, { mode, stations: [a.url, b.url], fingerprints: { [a.url]: a.fp, [b.url]: b.fp }, requestTimeoutMs: 300 });
      cleanups.push(() => cz.close());
      await expect(cz.jobs.create({ text: "x", idempotencyKey: "dip404" })).rejects.toBeInstanceOf(OutcomeUnknownError);
      expect(probes).toBeGreaterThanOrEqual(2);
      expect(b.jobRequests()).toHaveLength(0);
      expect(c.state.jobs).toHaveLength(0);
    });
  }

  it("browser: dip404", async () => {
    let probes = 0;
    const posted: string[] = [];
    const f = async (url: string, init: RequestInit): Promise<Response> => {
      if (init.method === "POST") {
        posted.push(url.startsWith(A) ? "A" : "B");
        return new Promise<Response>((_, rej) => setTimeout(() => rej(new DOMException("aborted", "AbortError")), 50));
      }
      if (url.includes("/jobs?")) return ++probes === 1 ? json(409, { error: { code: "in_progress", message: "x" } }) : json(404, { error: { code: "not_found", message: "x" } });
      return json(200, {});
    };
    let fellBack = false;
    const local = new CatzPrintLocal({ stations: [A, B], token: "t", fetch: f, timeoutMs: 20, fallback: async () => ((fellBack = true), { id: "c" }) });
    await expect(local.print({ text: "x" })).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(posted).toEqual(["A"]);
    expect(probes).toBeGreaterThanOrEqual(2);
    expect(fellBack).toBe(false);
  });
});

describe("SDK9-1: the re-sent request after a re-mint is classified like any other", () => {
  for (const kind of ["in_progress", "no id"] as const) {
    it(`401 token_expired → re-mint → re-send answered ${kind} → probe by key → the job`, async () => {
      // Before: the re-sent answer skipped the in_progress / C5 handling (a
      // ConflictError, or a "job" without an id).
      const c = await fakeCloud();
      cleanups.push(c.close);
      const a = await fakeStation();
      cleanups.push(a.close);
      let first: string | undefined;
      a.accept = (tok) => {
        first ??= tok;
        return tok !== first; // the first (minted) token is expired; the re-minted one works
      };
      if (kind === "in_progress") a.postInProgress = true;
      else a.emptyAnswer = true;
      const cz = localClient(c.url, { mode: "local_first", stations: [a.url], fingerprints: { [a.url]: a.fp } });
      cleanups.push(() => cz.close());
      const j = await cz.jobs.create({ text: "x", idempotencyKey: `rk-${kind}` });
      expect(j.via).toBe("local");
      expect(j.id).toMatch(/^lj_/);
      expect(c.state.mints).toHaveLength(2);
      expect(c.state.jobs).toHaveLength(0);
      expect(a.reqs.filter((r) => r.method === "GET" && r.path === "/local/v1/jobs").length).toBeGreaterThanOrEqual(1);
    });
  }
});

it("browser: any HTTP answer (not only 2xx) marks the station as recently reachable", async () => {
  let infos = 0;
  const f = async (url: string, init: RequestInit): Promise<Response> => {
    if (url.endsWith("/info")) {
      infos++;
      return json(503, { error: { code: "local_disabled", message: "x" } });
    }
    if (init.method === "POST") throw new TypeError("Failed to fetch");
    return json(200, { id: "lj_a", status: "queued" }); // probe: A has it
  };
  let fellBack = false;
  const local = new CatzPrintLocal({ stations: [A], token: "t", fetch: f, fallback: async () => ((fellBack = true), { id: "c" }) });
  await local.info(A).catch(() => undefined); // answered (503)
  infos = 0;
  expect(await local.print({ text: "x", idempotencyKey: "k3" })).toMatchObject({ id: "lj_a" });
  expect(infos).toBe(0); // answered < 30 s ago: no /info needed
  expect(fellBack).toBe(false);
});
