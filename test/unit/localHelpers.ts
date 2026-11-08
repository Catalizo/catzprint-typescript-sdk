import { readFileSync } from "node:fs";
import { createServer as createHttps, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createSocket } from "node:dgram";
import { X509Certificate, createHash } from "node:crypto";
import { CatzPrint } from "../../src/index.js";
import type { LocalOptions } from "../../src/local/manager.js";
import type { LocalEndpoint } from "../../src/local/types.js";
import { apiError, fakeApi, job, KEY, ORG, send } from "./helpers.js";

export const certs = JSON.parse(readFileSync(new URL("../fixtures/local-certs.json", import.meta.url), "utf8")) as Record<
  "selfSigned" | "otherSelfSigned" | "ca" | "publicLeaf",
  { cert: string; key?: string; fingerprint: string; host?: string }
>;

export interface StationReq {
  method: string;
  path: string;
  query: string;
  auth: string;
  body: any;
}

/** A fake CatzPrint station implementing the local API (spec §4.2). */
export async function fakeStation(cert = certs.selfSigned) {
  const reqs: StationReq[] = [];
  const jobs = new Map<string, any>();
  const byKey = new Map<string, string>();
  const st = {
    reqs,
    url: "",
    port: 0,
    fp: cert.fingerprint,
    accept: (tok: string) => tok.startsWith("czl1.") || tok.startsWith("czd_"),
    fail: undefined as undefined | ((path: string, method: string) => [number, string] | undefined),
    /** 401 code for refused tokens. */
    rejectCode: "token_expired",
    /** Every answer is a 5 MiB body (over the 4 MiB cap). */
    huge: false,
    /** Override the answer to GET /local/v1/jobs?idempotency_key= (e.g. [409, "duplicate"]). */
    probeAnswer: undefined as [number, string] | undefined,
    /** POST /local/v1/jobs records the job, then answers 201 "{}". */
    emptyAnswer: false,
    /** POST /local/v1/jobs records the job, then answers 409 in_progress. */
    postInProgress: false,
    /** Reported as LocalJob.live when set. */
    live: undefined as boolean | undefined,
    delayMs: 0,
    /** Delays POST /local/v1/jobs before recording it (request lost/slow). */
    jobDelayMs: 0,
    /** Delays the answer to POST /local/v1/jobs after recording it (answer lost). */
    answerDelayMs: 0,
    jobRequests: () => reqs.filter((r) => r.method === "POST" && r.path === "/local/v1/jobs"),
    close: async () => {},
  };
  const handle = (req: IncomingMessage, res: ServerResponse, raw: string) => {
    const u = new URL(req.url ?? "/", "https://x");
    let body: any;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = undefined;
    }
    reqs.push({ method: req.method ?? "", path: u.pathname, query: u.search.slice(1), auth: String(req.headers.authorization ?? ""), body });
    const err = (status: number, code: string) => apiError(res, status, code, `Station says ${code}.`);
    if (st.huge) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify("a".repeat(5 * 1024 * 1024)));
      return;
    }
    const f = st.fail?.(u.pathname, req.method ?? "");
    if (f) return err(f[0], f[1]);
    if (req.method === "GET" && u.pathname === "/local/v1/info") {
      return send(res, 200, { station_id: "st1", name: "Kitchen PC", org_id: ORG, location_id: "loc1", version: "3.0.0", port: 7443,
        tls_mode: "self_signed", cert_fingerprint_sha256: st.fp, hostnames: [], addresses: ["127.0.0.1"], pairing_open: true, time: new Date().toISOString() });
    }
    if (req.method === "POST" && u.pathname === "/local/v1/pair") {
      if (body?.code !== "12345678") return err(403, "invalid_code");
      return send(res, 201, { device_id: "d_0123456789abcdef", token: "czd_paired", station_id: "st1", org_id: ORG, location_id: "loc1" });
    }
    const tok = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!st.accept(tok)) return err(401, st.rejectCode);
    if (req.method === "POST" && u.pathname === "/local/v1/jobs") {
      const key = body?.idempotency_key ?? "";
      if (key && byKey.has(key)) return send(res, 200, jobs.get(byKey.get(key)!));
      const id = `lj_${(jobs.size + 1).toString(16).padStart(16, "0")}`;
      const waited = u.searchParams.get("wait");
      const j = { id, idempotency_key: key, status: waited ? "printed" : "queued", detail: "", printer_id: "p-kitchen", printer_name: "Kitchen",
        role: body?.role ?? "", location_id: "loc1", copies: body?.copies ?? 1, title: body?.title ?? "", reference: body?.reference ?? "",
        created_at: new Date().toISOString(), finished_at: waited ? new Date().toISOString() : null, printed_locally: true, via: "local", cloud_job_id: null,
        ...(st.live === undefined ? {} : { live: st.live }) };
      jobs.set(id, j);
      if (key) byKey.set(key, id);
      if (st.postInProgress) return err(409, "in_progress");
      const answer = st.emptyAnswer ? {} : j;
      if (st.answerDelayMs) {
        setTimeout(() => { if (!res.destroyed) send(res, 201, answer); }, st.answerDelayMs).unref();
        return;
      }
      return send(res, 201, answer);
    }
    if (req.method === "GET" && u.pathname === "/local/v1/jobs") {
      if (st.probeAnswer) return err(st.probeAnswer[0], st.probeAnswer[1]);
      const id = byKey.get(u.searchParams.get("idempotency_key") ?? "");
      if (!id) return err(404, "not_found");
      return send(res, 200, jobs.get(id));
    }
    if (req.method === "GET" && u.pathname.startsWith("/local/v1/jobs/")) {
      const j = jobs.get(decodeURIComponent(u.pathname.slice("/local/v1/jobs/".length)));
      if (!j) return err(404, "not_found");
      Object.assign(j, { status: "printed", finished_at: new Date().toISOString() });
      return send(res, 200, j);
    }
    if (req.method === "GET" && u.pathname === "/local/v1/status") {
      return send(res, 200, {
        station: { id: "st1", name: "Kitchen PC", cloud_connected: false, last_cloud_contact: null, version: "3.0.0", local_enabled: true },
        printers: [{ id: "p-kitchen", name: "Kitchen", role: "kitchen", status: "ready", paper: "ok", jobs_waiting: 0 }],
        jobs_waiting: 0, unsynced: 3, allowance: { expires_at: "2026-11-14T00:00:00Z", prints_left: 1997 },
      });
    }
    return err(404, "not_found");
  };
  const server: Server = createHttps({ cert: cert.cert, key: cert.key }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const go = () => { if (!res.destroyed) handle(req, res, Buffer.concat(chunks).toString("utf8")); };
      const isJobPost = req.method === "POST" && (req.url ?? "").startsWith("/local/v1/jobs");
      const delay = isJobPost && st.jobDelayMs ? st.jobDelayMs : st.delayMs;
      if (delay) setTimeout(go, delay).unref();
      else go();
    });
  });
  server.on("tlsClientError", () => {});
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  st.port = (server.address() as AddressInfo).port;
  st.url = `https://127.0.0.1:${st.port}`;
  st.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return st;
}

export function localToken(jti: string, live = true): string {
  const p = Buffer.from(JSON.stringify({ v: 1, kid: "k1", jti, org: ORG, key: "key1", loc: null, dev: "hub", live, iat: 1, exp: 2 })).toString("base64url");
  return `czl1.${p}.c2ln`;
}

/** A fake cloud: local-tokens, local-endpoints and jobs. */
export async function fakeCloud() {
  const state = {
    mints: [] as any[],
    jobs: [] as any[],
    endpoints: 0,
    revoked: [] as string[],
    stations: [] as LocalEndpoint[] | null,
    jobStatus: 0,
    /** The first N POST /jobs answer jobStatus, then succeed (0: always). */
    jobFailures: 0,
    /** POST /jobs: read the request, then drop the connection. */
    hangup: false,
    /** POST /jobs answers these statuses in turn (0 = created; the last one repeats). */
    jobSequence: [] as number[],
    /** Base64 X25519 key served at /v1/public/server-key (404 when unset). */
    serverKey: "",
    /** Server-key fetches served. */
    keyFetches: 0,
    /**
     * POST /jobs actions in turn: "hangup", "seal400" (a 400 naming
     * sealed_content), "409", "500" or "" (created); a last "x*" repeats.
     */
    jobActions: [] as string[],
    jobCode: "",
    down: false,
    expiresInMs: 30 * 86_400_000,
  };
  const api = await fakeApi((req, res) => {
    if (state.down) return apiError(res, 503, "unavailable", "Down.");
    if (req.url === "/v1/public/server-key" && state.serverKey) {
      state.keyFetches++;
      return send(res, 200, { public_key: state.serverKey, algorithm: "x25519" });
    }
    const base = `/v1/orgs/${ORG}`;
    const path = req.url.split("?")[0];
    if (req.method === "POST" && path === `${base}/local-tokens`) {
      state.mints.push(req.json);
      const jti = `jti-${state.mints.length}`;
      return send(res, 201, { token: localToken(jti), token_id: jti, expires_at: new Date(Date.now() + state.expiresInMs).toISOString(), stations: state.stations });
    }
    if (req.method === "DELETE" && path?.startsWith(`${base}/local-tokens/`)) {
      state.revoked.push(path.slice(`${base}/local-tokens/`.length));
      res.writeHead(204).end();
      return;
    }
    if (req.method === "GET" && path === `${base}/local-endpoints`) {
      state.endpoints++;
      return send(res, 200, { stations: state.stations });
    }
    if (req.method === "POST" && path === `${base}/jobs`) {
      state.jobs.push(req.json);
      if (state.hangup) {
        res.socket?.destroy();
        return;
      }
      if (state.jobActions.length) {
        const n = state.jobs.length;
        const last = state.jobActions[state.jobActions.length - 1]!;
        const act = (n <= state.jobActions.length ? state.jobActions[n - 1]! : last.endsWith("*") ? last : "").replace(/\*$/, "");
        if (act === "hangup") {
          res.socket?.destroy();
          return;
        }
        if (act === "seal400") {
          return send(res, 400, { error: { code: "invalid", message: "Couldn't decrypt.", fields: { sealed_content: "Couldn't decrypt." } } });
        }
        if (act === "409") return apiError(res, 409, "duplicate", "A job with this key is being created.");
        if (act === "500") return apiError(res, 500, "server_error", "boom");
        return send(res, 201, { job: job({ id: `cloud-${n}`, idempotency_key: req.json?.idempotency_key }) });
      }
      if (state.jobSequence.length) {
        const n = state.jobs.length;
        const st = state.jobSequence[Math.min(n, state.jobSequence.length) - 1]!;
        if (st !== 0) return apiError(res, st, state.jobCode || "x", "Cloud says no.");
        return send(res, 201, { job: job({ id: `cloud-${n}`, idempotency_key: req.json?.idempotency_key }) });
      }
      if (state.jobStatus && (state.jobFailures === 0 || state.jobs.length <= state.jobFailures)) {
        return apiError(res, state.jobStatus, state.jobCode, "Cloud says no.");
      }
      return send(res, 201, { job: job({ id: "cloud-1", idempotency_key: req.json?.idempotency_key }) });
    }
    return apiError(res, 404, "not_found", "Nope.");
  });
  return { ...api, state };
}

export const DEAD_CLOUD = "http://127.0.0.1:1";

export function localClient(baseUrl: string, local: LocalOptions) {
  return new CatzPrint({
    apiKey: KEY,
    baseUrl,
    orgId: ORG,
    maxRetries: 0,
    local: { connectTimeoutMs: 1000, requestTimeoutMs: 2000, cloudTimeoutMs: 2000, deviceName: "Hub", allLocations: !local.locationId, ...local },
  });
}

/** An https URL on a closed local port. */
export async function deadUrl(): Promise<string> {
  const { createServer } = await import("node:net");
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `https://127.0.0.1:${port}`;
}

/** Answers every mDNS query with `reply`, unicast to the sender. */
export async function fakeResponder(reply: Uint8Array) {
  const sock = createSocket("udp4");
  sock.on("message", (_msg, rinfo) => sock.send(reply, rinfo.port, rinfo.address));
  await new Promise<void>((r) => sock.bind(0, "127.0.0.1", r));
  return { target: { address: "127.0.0.1", port: sock.address().port }, close: () => new Promise<void>((r) => sock.close(() => r())) };
}

/** Hex SHA-256 of a certificate's SubjectPublicKeyInfo (DER). */
export function spkiOf(pem: string): string {
  return createHash("sha256").update(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" })).digest("hex");
}
