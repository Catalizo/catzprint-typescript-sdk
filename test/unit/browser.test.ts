import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  CatzPrintLocal,
  OutcomeUnknownError,
  StationUnreachableError,
  isOutOfPaper,
  isPrinterOffline,
} from "../../src/local/browser.js";

const A = "https://192-168-1-20.abcdefghij.local.catzprint.com:7443";
const B = "https://192-168-1-21.abcdefghij.local.catzprint.com:7443";

type Call = { url: string; init: RequestInit };
type Reply = { status: number; body?: unknown } | Error;

/** A scripted fetch: `route(url, init)` answers each call. */
function fakeFetch(route: (url: string, init: RequestInit, n: number) => Reply) {
  const calls: Call[] = [];
  const f = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const r = route(url, init, calls.length);
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  };
  return { f, calls };
}

const localJob = (over: Record<string, unknown> = {}) => ({
  id: "lj_0000000000000001", idempotency_key: "k", status: "queued", detail: "", printer_id: "p", printer_name: "Kitchen", role: "kitchen",
  location_id: "loc1", copies: 1, title: "", reference: "", created_at: "2026-11-07T00:00:00Z", finished_at: null, printed_locally: true,
  via: "local", cloud_job_id: null, ...over,
});
const err = (status: number, code: string) => ({ status, body: { error: { code, message: code } } });
const body = (c: Call) => JSON.parse(String(c.init.body));

describe("CatzPrintLocal (browser)", () => {
  it("prints with the token, an sdk- key and snake_case body", async () => {
    const { f, calls } = fakeFetch(() => ({ status: 201, body: localJob() }));
    const local = new CatzPrintLocal({ stations: [A], token: "czl1.x.y", fetch: f, waitSeconds: 3 });
    const job = await local.print({ role: "kitchen", templateId: "tpl", data: { table: "12" }, copies: 2 });
    expect(job).toMatchObject({ id: "lj_0000000000000001", station_url: A });
    expect(calls[0]!.url).toBe(`${A}/local/v1/jobs?wait=3`);
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer czl1.x.y");
    expect(h).not.toHaveProperty("Origin");
    expect(body(calls[0]!)).toMatchObject({ role: "kitchen", kind: "template", template_id: "tpl", data: { table: "12" }, copies: 2 });
    expect(body(calls[0]!).idempotency_key).toMatch(/^sdk-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("moves to the next station on network errors, 502/504 and 503 local_disabled; then calls fallback with the key", async () => {
    for (const first of [new TypeError("Failed to fetch"), err(502, "bad_gateway"), err(504, "gateway_timeout"), err(503, "local_disabled")]) {
      const { f, calls } = fakeFetch((url) => (url.startsWith(A) ? first : { status: 201, body: localJob() }));
      const local = new CatzPrintLocal({ stations: [A, B], token: "czd_t", fetch: f });
      expect(await local.print({ text: "x" })).toMatchObject({ station_url: B });
      // One POST per station (a network error adds a GET /info preflight, R2).
      expect(calls.filter((c) => c.init.method === "POST")).toHaveLength(2);
    }
    const { f } = fakeFetch(() => new TypeError("Failed to fetch"));
    const seen: unknown[] = [];
    const local = new CatzPrintLocal({
      stations: [A, B], token: "czd_t", fetch: f,
      fallback: async (params, error) => {
        seen.push(params.idempotencyKey, error);
        return { via: "cloud", id: "cloud-1" };
      },
    });
    expect(await local.print({ text: "x", idempotencyKey: "order-1042-kitchen-r1" })).toEqual({ via: "cloud", id: "cloud-1" });
    expect(seen[0]).toBe("order-1042-kitchen-r1");
    expect(seen[1]).toBeInstanceOf(StationUnreachableError);
    expect((seen[1] as StationUnreachableError).urls).toEqual([A, B]);
  });

  it("never falls back on printer errors, validation or 402", async () => {
    for (const [status, code] of [[503, "printer_offline"], [503, "out_of_paper"], [422, "no_printer"], [400, "invalid"], [402, "offline_allowance_exhausted"]] as const) {
      const { f, calls } = fakeFetch(() => err(status, code));
      let fell = false;
      const local = new CatzPrintLocal({ stations: [A, B], token: "czd_t", fetch: f, fallback: async () => { fell = true; return null; } });
      const e = await local.print({ text: "x" }).catch((x: unknown) => x);
      expect((e as { code: string }).code).toBe(code);
      expect(fell).toBe(false);
      expect(calls).toHaveLength(1);
    }
    const { f } = fakeFetch(() => err(503, "printer_offline"));
    const e = await new CatzPrintLocal({ stations: [A], token: "t", fetch: f }).print({ text: "x" }).catch((x: unknown) => x);
    expect(isPrinterOffline(e)).toBe(true);
    expect(isOutOfPaper(e)).toBe(false);
  });

  it("401: asks refreshToken once, then falls back", async () => {
    const { f, calls } = fakeFetch((_u, init) =>
      (init.headers as Record<string, string>).Authorization === "Bearer fresh" ? { status: 201, body: localJob() } : err(401, "token_expired"));
    const local = new CatzPrintLocal({ stations: [A], token: "old", fetch: f, refreshToken: async () => "fresh" });
    await local.print({ text: "x" });
    expect(calls).toHaveLength(2);
    expect(local.token).toBe("fresh");

    const { f: f2 } = fakeFetch(() => err(401, "token_expired"));
    let fallbackErr: unknown;
    const l2 = new CatzPrintLocal({ stations: [A], token: "old", fetch: f2, fallback: async (_p, e) => { fallbackErr = e; return "cloud"; } });
    expect(await l2.print({ text: "x" })).toBe("cloud");
    expect(fallbackErr).toBeInstanceOf(AuthenticationError);

    // device_revoked is never refreshed.
    let asked = 0;
    const { f: f3, calls: c3 } = fakeFetch(() => err(401, "device_revoked"));
    const l3 = new CatzPrintLocal({ stations: [A], token: "old", fetch: f3, refreshToken: async () => { asked++; return "fresh"; } });
    await expect(l3.print({ text: "x" })).rejects.toMatchObject({ code: "device_revoked" });
    expect(asked).toBe(0);
    expect(c3).toHaveLength(1);
  });

  it("pairs, then uses the device token", async () => {
    const { f, calls } = fakeFetch((url) =>
      url.endsWith("/pair") ? { status: 201, body: { device_id: "d_1", token: "czd_new", station_id: "st1", org_id: "o", location_id: "l" } } : { status: 201, body: localJob() });
    const local = new CatzPrintLocal({ fetch: f });
    await expect(local.print({ text: "x" })).rejects.toBeInstanceOf(AuthenticationError);
    await expect(local.pair(A, "12", "Till")).rejects.toThrow(TypeError);
    const p = await local.pair(A, "12345678", "Till 3");
    expect(p).toEqual({ token: "czd_new", deviceId: "d_1", stationId: "st1", orgId: "o", locationId: "l" });
    expect(JSON.parse(JSON.stringify(p)).token).toBe("czd_new");
    expect(String(p) + JSON.stringify(local)).not.toContain("czd_new");
    expect(body(calls[0]!)).toEqual({ code: "12345678", device_name: "Till 3" });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
    await local.print({ text: "x" });
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe("Bearer czd_new");
    expect(local.stations).toEqual([A]);
  });

  it("getJob prefers the station that took the job; status and info", async () => {
    const { f, calls } = fakeFetch((url) => {
      if (url.startsWith(A)) return new TypeError("down");
      if (url.endsWith("/status")) return { status: 200, body: { unsynced: 2 } };
      if (url.endsWith("/info")) return { status: 200, body: { station_id: "st1" } };
      return { status: url.includes("/jobs/") ? 200 : 201, body: localJob({ status: url.includes("/jobs/") ? "printed" : "queued" }) };
    });
    const local = new CatzPrintLocal({ stations: [A, B], token: "t", fetch: f });
    const j = await local.print({ text: "x" });
    const n = calls.length;
    expect((await local.getJob(j.id)).status).toBe("printed");
    expect(calls[n]!.url).toBe(`${B}/local/v1/jobs/lj_0000000000000001`);
    expect((await local.status()).station_url).toBe(B);
    expect((await local.info(B)).station_id).toBe("st1");
  });

  it("a timeout is ambiguous: probes, then OutcomeUnknown without fallback", async () => {
    const f = (_u: string, init: RequestInit) =>
      new Promise<Response>((_r, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    let fell = false;
    const local = new CatzPrintLocal({ stations: [A, B], token: "t", fetch: f, timeoutMs: 50, fallback: async () => { fell = true; return null; } });
    const e = (await local.print({ text: "x", idempotencyKey: "order-9" }).catch((x: unknown) => x)) as OutcomeUnknownError;
    expect(e).toBeInstanceOf(OutcomeUnknownError);
    expect(e).toMatchObject({ code: "outcome_unknown", url: A, idempotencyKey: "order-9" });
    expect(fell).toBe(false);
  });
});

describe("browser bundle", () => {
  const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

  it("src/local/browser.ts bundles for the browser with no Node built-ins", async () => {
    const entry = fileURLToPath(new URL("../../src/local/browser.ts", import.meta.url));
    const res = await build({ entryPoints: [entry], bundle: true, write: false, platform: "browser", format: "esm", metafile: true, logLevel: "silent" });
    const imports = Object.values(res.metafile.inputs).flatMap((i) => i.imports.map((x) => x.path));
    expect(imports.filter((p) => nodeBuiltins.has(p))).toEqual([]);
    const code = res.outputFiles[0]!.text;
    expect(code).not.toMatch(/\brequire\(|from\s*["']node:|\bBuffer\b|\bprocess\./);
  });

  it("the built dist/local.js (when present) has no Node built-ins", () => {
    const p = fileURLToPath(new URL("../../dist/local.js", import.meta.url));
    if (!existsSync(p)) return;
    const code = readFileSync(p, "utf8");
    const specs = [...code.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((m) => m[1]!);
    expect(specs.filter((s) => nodeBuiltins.has(s))).toEqual([]);
    expect(code).not.toMatch(/\brequire\(|\bBuffer\b|\bprocess\./);
  });

  it("package.json exports ./local as ESM", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.exports["./local"].import).toEqual({ types: "./dist/local.d.ts", default: "./dist/local.js" });
  });
});
