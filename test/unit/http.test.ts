import { afterEach, describe, expect, it } from "vitest";
import {
  CatzPrint,
  ConflictError,
  ConnectionError,
  RateLimitError,
  ServerError,
  ValidationError,
  type Job,
} from "../../src/index.js";
import { HttpClient, backoffMs } from "../../src/http.js";
import { apiError, fakeApi, job, KEY, ORG, send } from "./helpers.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let api: Awaited<ReturnType<typeof fakeApi>> | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

function client(extra: Record<string, unknown> = {}) {
  return new CatzPrint({ apiKey: KEY, baseUrl: api!.url, orgId: ORG, ...extra });
}

describe("backoff", () => {
  it("grows exponentially with jitter and caps at 8s", () => {
    expect(backoffMs(0, () => 0)).toBe(250);
    expect(backoffMs(0, () => 1)).toBe(500);
    expect(backoffMs(1, () => 1)).toBe(1000);
    expect(backoffMs(2, () => 0.5)).toBe(1500);
    expect(backoffMs(10, () => 1)).toBe(8000);
    for (let i = 0; i < 100; i++) {
      const v = backoffMs(1);
      expect(v).toBeGreaterThanOrEqual(500);
      expect(v).toBeLessThanOrEqual(1000);
    }
  });
});

describe("HttpClient retry policy (injected sleep)", () => {
  async function run(statuses: number[], opts: { method?: "GET" | "POST"; idempotent?: boolean; retryAfter?: string } = {}) {
    api = await fakeApi((_r, res, n) => {
      const st = statuses[n - 1] ?? 200;
      if (st === 200) return send(res, 200, { ok: true });
      apiError(res, st, st === 429 ? "rate_limited" : "unavailable", "Busy.", {}, opts.retryAfter ? { "Retry-After": opts.retryAfter } : {});
    });
    const sleeps: number[] = [];
    const http = new HttpClient({
      apiKey: KEY,
      baseUrl: api.url,
      timeoutMs: 5000,
      maxRetries: 2,
      maxRetryAfterSeconds: 60,
      fetch: globalThis.fetch,
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 0.5,
    });
    const p = http.request<{ ok: boolean }>({
      method: opts.method ?? "GET",
      path: "/v1/x",
      body: opts.method === "POST" ? {} : undefined,
      idempotent: opts.idempotent,
    });
    return { p, sleeps };
  }

  it("retries 502/503/504 then succeeds", async () => {
    const { p, sleeps } = await run([502, 504]);
    await expect(p).resolves.toEqual({ ok: true });
    expect(api!.requests).toHaveLength(3);
    expect(sleeps).toEqual([375, 750]);
  });

  it("gives up after maxRetries (3 attempts)", async () => {
    const { p } = await run([503, 503, 503, 503]);
    await expect(p).rejects.toBeInstanceOf(ServerError);
    expect(api!.requests).toHaveLength(3);
  });

  it("waits at least Retry-After on 429", async () => {
    const { p, sleeps } = await run([429], { retryAfter: "4" });
    await expect(p).resolves.toEqual({ ok: true });
    expect(sleeps).toEqual([4000]);
  });

  it("throws RateLimitError at once when Retry-After is too long", async () => {
    const { p, sleeps } = await run([429], { retryAfter: "3600" });
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfter).toBe(3600);
    expect(sleeps).toEqual([]);
    expect(api!.requests).toHaveLength(1);
  });

  it("never retries a POST without an idempotency key", async () => {
    const { p } = await run([503], { method: "POST" });
    await expect(p).rejects.toBeInstanceOf(ServerError);
    expect(api!.requests).toHaveLength(1);
  });

  it("retries a POST marked idempotent", async () => {
    const { p } = await run([503], { method: "POST", idempotent: true });
    await expect(p).resolves.toEqual({ ok: true });
    expect(api!.requests).toHaveLength(2);
  });

  it("does not retry other 4xx/5xx", async () => {
    const { p } = await run([500]);
    await expect(p).rejects.toBeInstanceOf(ServerError);
    expect(api!.requests).toHaveLength(1);
  });
});

describe("CatzPrint over a fake API", () => {
  it("sends auth and user agent, and looks up the org once", async () => {
    api = await fakeApi((r, res) => {
      if (r.url === "/v1/key") return send(res, 200, { id: "k1", org_id: ORG, org_name: "Shop", live: false, scopes: ["jobs:read"] });
      send(res, 200, { printers: [] });
    });
    const cz = new CatzPrint({ apiKey: KEY, baseUrl: api.url + "/" });
    await cz.printers.list();
    await cz.printers.list({ stationId: "abc" });
    expect(api.requests.map((r) => r.url)).toEqual([
      "/v1/key",
      `/v1/orgs/${ORG}/printers`,
      `/v1/orgs/${ORG}/printers?station_id=abc`,
    ]);
    expect(api.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(api.requests[0]!.headers["user-agent"]).toBe("catzprint-node/2.1.3");
    expect((await cz.whoami()).org_name).toBe("Shop");
    expect(api.requests).toHaveLength(3);
  });

  it("jobs.create reuses one generated idempotency key across retries", async () => {
    api = await fakeApi((r, res, n) => {
      if (n < 3) return apiError(res, n === 1 ? 502 : 429, "busy", "Busy.", n === 2 ? { retry_after_seconds: 1 } : {});
      send(res, 201, { job: job({ title: r.json.title }) });
    });
    const j = await client().jobs.create({ text: "hi", printerId: "p1", title: "T" });
    expect(j.title).toBe("T");
    const keys = api.requests.map((r) => r.json.idempotency_key);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(UUID_V4);
    expect(api.requests[0]!.json).toEqual({ printer_id: "p1", title: "T", idempotency_key: keys[0], content: "hi", kind: "text" });
    expect(api.requests[0]!.url).toBe(`/v1/orgs/${ORG}/jobs`);
  });

  it("jobs.create uses the caller's idempotency key, and new keys per call", async () => {
    api = await fakeApi((_r, res) => send(res, 201, { job: job() }));
    const cz = client();
    await cz.jobs.create({ text: "a", idempotencyKey: "order-1042" });
    await cz.jobs.create({ text: "a" });
    await cz.jobs.create({ text: "a" });
    const keys = api.requests.map((r) => r.json.idempotency_key);
    expect(keys[0]).toBe("order-1042");
    expect(keys[1]).not.toBe(keys[2]);
  });

  it("jobs.create asks again after a 409 duplicate (original still running)", async () => {
    api = await fakeApi((_r, res, n) => {
      if (n === 1) return apiError(res, 409, "duplicate", "A job with this idempotency key is being created.");
      send(res, 200, { job: job({ id: "same" }) });
    });
    const j = await client().jobs.create({ text: "x", idempotencyKey: "k" });
    expect(j.id).toBe("same");
    expect(api.requests).toHaveLength(2);
  });

  it("jobs.cancel / retry / reprint are not retried", async () => {
    api = await fakeApi((_r, res) => apiError(res, 503, "unavailable", "Down."));
    const cz = client();
    await expect(cz.jobs.cancel("j1")).rejects.toBeInstanceOf(ServerError);
    await expect(cz.jobs.retry("j1")).rejects.toBeInstanceOf(ServerError);
    await expect(cz.jobs.reprint("j1", { copies: 2 })).rejects.toBeInstanceOf(ServerError);
    expect(api.requests.map((r) => `${r.method} ${r.url} ${r.body}`)).toEqual([
      `POST /v1/orgs/${ORG}/jobs/j1/cancel {}`,
      `POST /v1/orgs/${ORG}/jobs/j1/retry {}`,
      `POST /v1/orgs/${ORG}/jobs/j1/reprint {"copies":2}`,
    ]);
  });

  it("maps a 400 with fields to ValidationError without retrying", async () => {
    api = await fakeApi((_r, res) =>
      apiError(res, 400, "invalid", "Unknown printer.", { fields: { printer_id: "Unknown printer." } }),
    );
    const err = await client().printText("x", { printerId: "nope" }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.fields).toEqual({ printer_id: "Unknown printer." });
    expect(api.requests).toHaveLength(1);
  });

  it("retries network errors on GET, then throws ConnectionError", async () => {
    api = await fakeApi((r, res) => {
      res.socket?.destroy();
    });
    const err = await client({ maxRetries: 1 }).jobs.get("j1").catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.code).toBe("connection_error");
    expect(err.status).toBe(0);
    expect(api.requests).toHaveLength(2);
  });

  it("recovers from one dropped connection on jobs.create", async () => {
    api = await fakeApi((_r, res, n) => {
      if (n === 1) return res.socket?.destroy();
      send(res, 201, { job: job() });
    });
    await expect(client().jobs.create({ text: "x" })).resolves.toMatchObject({ status: "queued" });
    expect(api.requests[0]!.json.idempotency_key).toBe(api.requests[1]!.json.idempotency_key);
  });

  it("times out", async () => {
    api = await fakeApi(() => {
      /* never answers */
    });
    const err = await client({ timeoutMs: 150, maxRetries: 0 }).jobs.get("j1").catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.code).toBe("timeout");
  });

  it("lists with filters and iterates every page", async () => {
    api = await fakeApi((r, res) => {
      const u = new URL(r.url, "http://x");
      const cursor = u.searchParams.get("cursor");
      if (!cursor) return send(res, 200, { items: [job({ id: "a" }), job({ id: "b" })], next_cursor: "c1", counts: {} });
      if (cursor === "c1") return send(res, 200, { items: [job({ id: "c" })], next_cursor: "", counts: {} });
    });
    const cz = client();
    const page = await cz.jobs.list({ status: ["failed", "held"], printerId: "p", live: false, limit: 2, since: new Date(0) });
    expect(page.next_cursor).toBe("c1");
    expect(api.requests[0]!.url).toBe(
      `/v1/orgs/${ORG}/jobs?status=failed%2Cheld&printer_id=p&live=false&since=1970-01-01T00%3A00%3A00.000Z&limit=2`,
    );
    const ids: string[] = [];
    for await (const j of cz.jobs.iterate({ limit: 2 })) ids.push(j.id);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("waitFor polls until a final status", async () => {
    const statuses = ["queued", "sent", "printing", "printed"];
    api = await fakeApi((_r, res, n) => send(res, 200, { job: job({ status: statuses[n - 1] }), events: [] }));
    const j = await client().jobs.waitFor("j1", { intervalMs: 10 });
    expect(j.status).toBe("printed");
    expect(api.requests).toHaveLength(4);
  });

  it("waitFor throws TimeoutError with the last job", async () => {
    api = await fakeApi((_r, res) => send(res, 200, { job: job({ status: "queued" }), events: [] }));
    const err = await client().jobs.waitFor("j1", { timeoutMs: 120, intervalMs: 30 }).catch((e) => e);
    expect(err.name).toBe("TimeoutError");
    expect(err.jobId).toBe("j1");
    expect((err.lastJob as Job).status).toBe("queued");
  });

  it("conflicts surface as ConflictError", async () => {
    api = await fakeApi((_r, res) => apiError(res, 409, "invalid_state", "A printed job can't be changed this way."));
    await expect(client().jobs.cancel("j1")).rejects.toBeInstanceOf(ConflictError);
  });

  it("locations, templates and server key", async () => {
    api = await fakeApi((r, res) => {
      if (r.url.endsWith("/locations")) return send(res, 200, { locations: [{ id: "l1" }] });
      if (r.url.endsWith("/locations/l1")) return send(res, 200, { location: { id: "l1", name: "Front" } });
      if (r.url.endsWith("/templates")) return send(res, 200, { templates: [{ id: "t1" }] });
      if (r.url === "/v1/public/server-key") return send(res, 200, { public_key: Buffer.alloc(32, 9).toString("base64"), algorithm: "x" });
    });
    const cz = client();
    expect(await cz.locations.list()).toEqual([{ id: "l1" }]);
    expect((await cz.locations.get("l1")).name).toBe("Front");
    expect(await cz.templates.list()).toEqual([{ id: "t1" }]);
    await cz.seal(new Uint8Array(3));
    await cz.seal(new Uint8Array(3));
    expect(api.requests.filter((r) => r.url === "/v1/public/server-key")).toHaveLength(1);
  });
});

describe("transport hardening", () => {
  it("doesn't follow redirects (the Authorization header stays on the API host)", async () => {
    let other: Awaited<ReturnType<typeof fakeApi>> | undefined;
    try {
      other = await fakeApi((_r, res) => send(res, 200, { leaked: true }));
      api = await fakeApi((_r, res) => {
        res.writeHead(302, { Location: other!.url + "/steal" });
        res.end();
      });
      const err = await client().printers.list().catch((e) => e);
      expect(err.code).toBe("unexpected_redirect");
      expect(other.requests).toHaveLength(0);
    } finally {
      await other?.close();
    }
  });

  it("refuses an oversized response body", async () => {
    const { MAX_RESPONSE_BYTES } = await import("../../src/http.js");
    api = await fakeApi((_r, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      let sent = 0;
      const pump = () => {
        while (sent <= MAX_RESPONSE_BYTES) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      pump();
    });
    const err = await client().printers.list().catch((e) => e);
    expect(err.code).toBe("response_too_large");
  });

  it("rejects a malformed server key", async () => {
    api = await fakeApi((_r, res) => send(res, 200, { public_key: Buffer.alloc(16).toString("base64") }));
    await expect(client().serverPublicKey()).rejects.toThrow(/malformed/);
  });
});
