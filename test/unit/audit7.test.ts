// Regression tests for SDK addendum 5 (audit round 7): S1 (re-seal after a
// sealed_content 400, also after an ambiguous attempt: the amb400/seal400
// matrix scenarios), S2 (server-key TTL), S3 (browser /info budget), S4 (POST
// 409 in_progress then probe 404: the ip404 scenario) and S6.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatzPrint, OutcomeUnknownError, StationUnreachableError, ValidationError, type StoredToken, type TokenStore } from "../../src/index.js";
import { CatzPrintLocal } from "../../src/local/browser.js";
import { isRedactedToken } from "../../src/local/shared.js";
import { boxKeyPair } from "../../src/nacl.js";
import { KEY, ORG } from "./helpers.js";
import { fakeCloud, fakeStation, localClient } from "./localHelpers.js";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
});
async function station() {
  const s = await fakeStation();
  cleanups.push(s.close);
  return s;
}
async function cloud(...actions: string[]) {
  const c = await fakeCloud();
  c.state.jobActions = actions;
  c.state.serverKey = Buffer.from(boxKeyPair().publicKey).toString("base64");
  cleanups.push(c.close);
  return c;
}
type Cloud = Awaited<ReturnType<typeof cloud>>;
type Station = Awaited<ReturnType<typeof station>>;
const posts = (c: Cloud) => c.requests.filter((r) => r.method === "POST" && r.url.endsWith("/jobs")).map((r) => JSON.parse(r.body));

/** A client with the client's retry policy on (maxRetries 2), like the matrix's MAXR=2. */
function client(c: Cloud, mode: "cloud" | "local_first" | "cloud_first", st: Station) {
  const cz = new CatzPrint({
    apiKey: KEY,
    baseUrl: c.url,
    orgId: ORG,
    maxRetries: 2,
    local: mode === "cloud" ? undefined : { mode, stations: [st.url], fingerprints: { [st.url]: st.fp }, allLocations: true, requestTimeoutMs: 2000, cloudTimeoutMs: 2000 },
  });
  cleanups.push(() => cz.close());
  return cz;
}
const MODES = ["cloud", "local_first", "cloud_first"] as const;

describe("S1: a sealed_content 400 re-seals once", () => {
  for (const mode of MODES) {
    it(`${mode} amb400: lost answer, then 400 → re-sealed re-send returns the job`, async () => {
      // Before: ValidationError (the caller would print again with a new key).
      const c = await cloud("hangup", "seal400", "");
      const st = await station();
      const j = await client(c, mode, st).jobs.create({ text: "card", sealed: true, idempotencyKey: "amb-1" });
      expect(j.id).toBe("cloud-3");
      const p = posts(c);
      expect(p).toHaveLength(3);
      expect(c.state.keyFetches).toBe(2);
      expect(p[0].sealed_content).toBe(p[1].sealed_content);
      expect(p[2].sealed_content).not.toBe(p[1].sealed_content);
      expect(p[2].idempotency_key).toBe("amb-1");
      expect(st.reqs).toHaveLength(0);
    });

    for (const last of ["seal400*", "hangup*"]) {
      it(`${mode} amb400 then ${last}: OutcomeUnknown, never ValidationError, never local`, async () => {
        const c = await cloud("hangup", "seal400", last);
        const st = await station();
        const err = await client(c, mode, st).jobs.create({ text: "card", sealed: true, idempotencyKey: "amb-2" }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(OutcomeUnknownError);
        expect(st.reqs).toHaveLength(0);
      });
    }

    it(`${mode} seal400: re-fetches the key and re-seals once; a repeat is the ValidationError`, async () => {
      const c = await cloud("seal400", "");
      const st = await station();
      expect((await client(c, mode, st).jobs.create({ text: "card", sealed: true })).id).toBe("cloud-2");
      expect(c.state.keyFetches).toBe(2);
      const c2 = await cloud("seal400*");
      const err = await client(c2, mode, st).jobs.create({ text: "card", sealed: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(posts(c2)).toHaveLength(2);
      expect(st.reqs).toHaveLength(0);
    });
  }

  it("an unsealed job's 400 is never re-sent", async () => {
    const c = await cloud("seal400*");
    const st = await station();
    await expect(client(c, "cloud", st).printPdf(new Uint8Array(Buffer.from("%PDF-1.4 x")))).rejects.toBeInstanceOf(ValidationError);
    expect(posts(c)).toHaveLength(1);
  });

  it("a sealed_content 400 to a re-send after a 409 is OutcomeUnknown", async () => {
    const c = await cloud("409", "seal400*");
    const st = await station();
    await expect(client(c, "cloud", st).jobs.create({ text: "x", sealed: true })).rejects.toBeInstanceOf(OutcomeUnknownError);
  });
});

it("S2: the server key is cached for an hour, then fetched again", async () => {
  const c = await cloud();
  const st = await station();
  const cz = client(c, "cloud", st);
  await cz.serverPublicKey();
  await cz.serverPublicKey();
  expect(c.state.keyFetches).toBe(1);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 61 * 60_000);
  await cz.serverPublicKey();
  expect(c.state.keyFetches).toBe(2);
});

describe("S4: POST 409 in_progress, then probe 404 → OutcomeUnknown", () => {
  for (const mode of ["local", "local_first", "cloud_first"] as const) {
    it(mode, async () => {
      // Before: the next station / the cloud got the job (double print).
      const c = await fakeCloud();
      cleanups.push(c.close);
      if (mode === "cloud_first") c.state.jobStatus = 503;
      const a = await station();
      const b = await station();
      a.fail = (path, method) => (method === "POST" && path === "/local/v1/jobs" ? [409, "in_progress"] : undefined); // not recorded
      const cz = localClient(c.url, { mode, stations: [a.url, b.url], fingerprints: { [a.url]: a.fp, [b.url]: b.fp } });
      cleanups.push(() => cz.close());
      await expect(cz.jobs.create({ text: "x", idempotencyKey: "ip404" })).rejects.toBeInstanceOf(OutcomeUnknownError);
      expect(b.reqs).toHaveLength(0);
      if (mode === "local_first") expect(c.state.jobs).toHaveLength(0);
    });
  }

  it("browser", async () => {
    const A = "https://192-168-1-20.abcdefghij.local.catzprint.com:7443";
    const B = "https://192-168-1-21.abcdefghij.local.catzprint.com:7443";
    const posted: string[] = [];
    const f = async (url: string, init: RequestInit): Promise<Response> => {
      if (init.method === "POST") {
        posted.push(url.startsWith(A) ? "A" : "B");
        return new Response(JSON.stringify({ error: { code: "in_progress", message: "x" } }), { status: 409 });
      }
      return new Response(JSON.stringify({ error: { code: "not_found", message: "x" } }), { status: 404 });
    };
    let fellBack = false;
    const local = new CatzPrintLocal({ stations: [A, B], token: "t", fetch: f, fallback: async () => (fellBack = true) });
    await expect(local.print({ text: "x" })).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(posted).toEqual(["A"]);
    expect(fellBack).toBe(false);
  });
});

describe("S3: browser /info budget", () => {
  const urls = [20, 21, 22].map((n) => `https://192-168-1-${n}.abcdefghij.local.catzprint.com:7443`);

  it("stations that never answered get a single /info try each", async () => {
    let infos = 0;
    const f = async (url: string): Promise<Response> => {
      if (url.endsWith("/info")) infos++;
      throw new TypeError("Failed to fetch");
    };
    const local = new CatzPrintLocal({ stations: urls, token: "t", fetch: f });
    const t0 = Date.now();
    await expect(local.print({ text: "x" })).rejects.toBeInstanceOf(StationUnreachableError);
    expect(infos).toBe(3);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("the long retry is only for a station that answered before, within one ~5 s budget for all", { timeout: 15_000 }, async () => {
    let up = true;
    const infos: string[] = [];
    const f = async (url: string): Promise<Response> => {
      if (url.endsWith("/info")) {
        infos.push(url.slice(0, urls[0]!.length));
        if (up) return new Response("{}", { status: 200 });
      }
      throw new TypeError("Failed to fetch");
    };
    const local = new CatzPrintLocal({ stations: urls, token: "t", fetch: f });
    for (const u of urls) await local.info(u); // every station answered once
    up = false;
    infos.length = 0;
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 31_000); // > 30 s since they answered
    const t0 = performance.now();
    await expect(local.print({ text: "x" })).rejects.toBeInstanceOf(StationUnreachableError);
    const took = performance.now() - t0;
    expect(took).toBeGreaterThan(4_000);
    expect(took).toBeLessThan(7_000); // one budget, not one per station
    expect(infos.filter((u) => u === urls[0]).length).toBeGreaterThan(1);
  });
});

describe("S6: placeholders and the store error", () => {
  it("the shared placeholder set", () => {
    for (const p of ["…", "***", "*****", "[redacted]", "REDACTED", "hidden", "czl1.…", "czl1.***", "czd_[redacted]", "czd_hidden"]) {
      expect(isRedactedToken(p), p).toBe(true);
    }
    for (const p of ["czl1.abc.def", "czd_abc", "**", "czl1.**", "redacted-token"]) expect(isRedactedToken(p), p).toBe(false);
  });

  it("the store error is cleared after a successful re-mint", async () => {
    const c = await fakeCloud();
    cleanups.push(c.close);
    const st = await station();
    const store: TokenStore & { saved?: StoredToken } = {
      async load() {
        return { token: "czl1.[redacted]", expires_at: new Date(Date.now() + 20 * 86_400_000).toISOString() };
      },
      async save(_k, t) {
        store.saved = t;
      },
    };
    const cz = localClient(c.url, { mode: "local", stations: [st.url], fingerprints: { [st.url]: st.fp }, tokenStore: store });
    cleanups.push(() => cz.close());
    await cz.jobs.create({ text: "x" });
    expect(st.jobRequests()[0]!.auth).not.toContain("redacted");
    expect(c.state.mints).toHaveLength(1);
    expect(cz.local.storeError).toBeUndefined();
  });
});
