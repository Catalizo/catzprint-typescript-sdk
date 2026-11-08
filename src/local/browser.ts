// catzprint/local: print from a browser POS straight to a CatzPrint station
// on the same network. ESM, no Node built-ins: fetch + WebCrypto only.
//
//   import { CatzPrintLocal } from "catzprint/local";
//   const local = new CatzPrintLocal({ stations: ["https://192-168-1-20.ab3k9x2mqp.local.catzprint.com:7443"], token });
//   const job = await local.print({ role: "kitchen", templateId, data, idempotencyKey: "order-1042-kitchen-r1" });
import {
  AuthenticationError,
  CatzPrintError,
  OutcomeUnknownError,
  StationUnreachableError,
  type StationAttempt,
} from "../errors.js";
import {
  LOCAL_API,
  MAX_LOCAL_RESPONSE,
  checkIdempotencyKey,
  checkPairingCode,
  connectionError,
  isUnreachableAnswer,
  localBody,
  normalizeStationUrl,
  sdkIdempotencyKey,
  stationError,
  toPairing,
  withStation,
} from "./shared.js";
import type { LocalInfo, LocalJob, LocalPairing, LocalPrintParams, LocalStatus } from "./types.js";

export type { LocalInfo, LocalJob, LocalPairing, LocalPrintParams, LocalStatus } from "./types.js";
export {
  AuthenticationError,
  CatzPrintError,
  ConnectionError,
  NotFoundError,
  OutcomeUnknownError,
  OutOfPrintsError,
  PermissionError,
  PrinterError,
  RateLimitError,
  ServerError,
  StationUnreachableError,
  ValidationError,
  isCoverOpen,
  isOfflineAllowanceExhausted,
  isOutOfPaper,
  isPrinterOffline,
  isStationUnreachable,
  isOutcomeUnknown,
} from "../errors.js";
export type { StationAttempt } from "../errors.js";

type BrowserFetch = (input: string, init: RequestInit) => Promise<Response>;

/** What the fallback hook receives: the params with the idempotency key that was used. */
export type FallbackParams = LocalPrintParams & { idempotencyKey: string };

export interface CatzPrintLocalOptions<F = LocalJob> {
  /** Station URLs, tried in order. Browsers only accept stations with a certificate they trust (the public `…local.catzprint.com` hostnames). */
  stations?: string[];
  /** A local token (`czl1.…`, minted by your backend) or a device token from `pair()` (`czd_…`). */
  token?: string;
  /**
   * Called when no station can take a print (or the token is refused), with
   * the same idempotency key, so your POS can send the job through its
   * backend / the cloud. Its result is returned by `print()`. Printer errors
   * (`printer_offline`, `out_of_paper`…), validation errors and 402 never
   * reach it.
   */
  fallback?: (params: FallbackParams, error: CatzPrintError) => Promise<F>;
  /** Called once on a 401 `token_expired` (never `device_revoked`) to get a fresh token, e.g. from your backend. Return undefined to give up. */
  refreshToken?: () => Promise<string | undefined>;
  /** Per-request timeout in ms (default 15000). Browsers can't time the connection separately. */
  timeoutMs?: number;
  /** Ask the station to answer once the job printed or failed, 0..30 s (default 0). */
  waitSeconds?: number;
  /** Custom fetch (default: the global fetch). */
  fetch?: BrowserFetch;
}

/** Prints through CatzPrint stations on the local network, from a browser. */
export class CatzPrintLocal<F = LocalJob> {
  #stations: string[];
  #token: string | undefined;
  readonly #o: CatzPrintLocalOptions<F>;
  readonly #fetch: BrowserFetch;
  readonly #jobStation = new Map<string, string>();
  /** When each station last answered successfully (any endpoint). */
  readonly #lastOk = new Map<string, number>();

  constructor(options: CatzPrintLocalOptions<F> = {}) {
    this.#o = options;
    this.#stations = (options.stations ?? []).map(normalizeStationUrl);
    this.#token = options.token;
    const f = options.fetch ?? (globalThis.fetch?.bind(globalThis) as BrowserFetch | undefined);
    if (!f) throw new Error("No fetch available.");
    this.#fetch = f;
    if (options.waitSeconds !== undefined && !(options.waitSeconds >= 0 && options.waitSeconds <= 30)) {
      throw new TypeError("waitSeconds must be between 0 and 30.");
    }
  }

  /** The station URLs in use. */
  get stations(): string[] {
    return [...this.#stations];
  }

  /** The token in use (after `pair()`, the device token). */
  get token(): string | undefined {
    return this.#token;
  }

  set token(t: string | undefined) {
    this.#token = t;
  }

  /**
   * Pairs this browser with a station using the 8-digit code shown in the
   * station app. The device token is kept for later calls and the station is
   * added to the list. Store `token` (e.g. in IndexedDB) and pass it next time.
   */
  async pair(url: string, code: string, deviceName: string): Promise<LocalPairing> {
    checkPairingCode(code);
    const u = normalizeStationUrl(url);
    const r = await this.#request(u, "POST", "/pair", undefined, { code, device_name: String(deviceName).slice(0, 80) });
    if (r.unreachable) throw new StationUnreachableError([{ url: u, error: r.error }]);
    if (r.error) throw r.error;
    const p = toPairing(r.data as Record<string, unknown>);
    this.#token = p.token;
    if (!this.#stations.includes(u)) this.#stations.unshift(u);
    return p;
  }

  /**
   * Prints a job on the first station that takes it. Without an
   * `idempotencyKey`, `sdk-<uuid>` is used (the same key goes to `fallback`).
   */
  async print(params: LocalPrintParams): Promise<LocalJob | F> {
    // A blank key means "no key"; padded keys or control characters are refused.
    const idempotencyKey = checkIdempotencyKey(params.idempotencyKey) ?? sdkIdempotencyKey();
    if (idempotencyKey.length > 200) throw new TypeError("idempotencyKey is at most 200 characters.");
    const body = localBody(params, idempotencyKey);
    const wait = this.#o.waitSeconds ? `?wait=${Math.ceil(this.#o.waitSeconds)}` : "";
    try {
      const { data, url } = await this.#authed("POST", `/jobs${wait}`, body, this.#o.waitSeconds ?? 0, undefined, idempotencyKey);
      const job = withStation(data as LocalJob, url);
      this.#jobStation.set(job.id, url);
      return job;
    } catch (err) {
      if (this.#o.fallback && (err instanceof StationUnreachableError || err instanceof AuthenticationError)) {
        return this.#o.fallback({ ...params, idempotencyKey }, err);
      }
      throw err;
    }
  }

  /** Gets a local job ("lj_…"). */
  async getJob(id: string): Promise<LocalJob> {
    const pref = this.#jobStation.get(id);
    const { data, url } = await this.#authed("GET", `/jobs/${encodeURIComponent(id)}`, undefined, 0, pref);
    return withStation(data as LocalJob, url);
  }

  /** Finds a job by its idempotency key (404 → NotFoundError). */
  async findJob(idempotencyKey: string): Promise<LocalJob> {
    const { data, url } = await this.#authed("GET", `/jobs?idempotency_key=${encodeURIComponent(idempotencyKey)}`, undefined, 0);
    return withStation(data as LocalJob, url);
  }

  /** The first reachable station's status: printers, paper, unsynced jobs, offline allowance. */
  async status(): Promise<LocalStatus> {
    const { data, url } = await this.#authed("GET", "/status", undefined, 0);
    return { ...(data as LocalStatus), station_url: url };
  }

  /** A station's public info (no token needed). */
  async info(url: string): Promise<LocalInfo> {
    const u = normalizeStationUrl(url);
    const r = await this.#request(u, "GET", "/info");
    if (r.unreachable) throw new StationUnreachableError([{ url: u, error: r.error }]);
    if (r.error) throw r.error;
    return r.data as LocalInfo;
  }

  /** Never includes the token. */
  toJSON(): Record<string, unknown> {
    return { stations: this.#stations, hasToken: !!this.#token };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `CatzPrintLocal(${JSON.stringify(this.toJSON())})`;
  }

  /** Asks a station by idempotency key whether it recorded a job (3 tries within 5 s). */
  /**
   * Probe answers: 200 with a job → that job; 404 `not_found` → never
   * recorded (unless an earlier answer said in_progress: unknown); 409 `duplicate` → the key belongs to a job this device can't
   * see (an answer, thrown as is); anything else → keep probing.
   */
  async #probe(url: string, key: string): Promise<{ found?: unknown; notFound?: boolean; conflict?: CatzPrintError }> {
    const deadline = Date.now() + 5_000;
    let sawInProgress = false;
    for (let i = 0; i < 3; i++) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const r = await this.#request(url, "GET", `/jobs?idempotency_key=${encodeURIComponent(key)}`, this.#token, undefined, 0, Math.min(left, this.#o.timeoutMs ?? 15_000));
      if (!r.error && (r.data as { id?: unknown } | undefined)?.id) return { found: r.data };
      // After an in_progress answer, a 404 isn't "never recorded" (T2): unknown.
      if (r.error?.status === 404 && r.error.code === "not_found") return sawInProgress ? {} : { notFound: true };
      if (r.error?.status === 409 && r.error.code === "duplicate") return { conflict: r.error };
      if (r.error?.status === 409 && r.error.code === "in_progress") sawInProgress = true;
      if (i < 2) await new Promise((res) => setTimeout(res, Math.max(0, Math.min(5_000 / 6, deadline - Date.now()))));
    }
    return {};
  }

  /**
   * Did this station answer in the last 30 s, or does GET /info answer now?
   * A station whose job request just failed with a network error always gets
   * at least one /info try of at most 1 s (T1). Only a station that has
   * answered at least once in this client's lifetime gets extra tries, until
   * it answers or the ~5 s budget of this print() is spent; the budget counts
   * only time actually spent probing /info (S3, T1).
   */
  async #recentlyReachable(url: string, budget: InfoBudget): Promise<boolean> {
    const last = this.#lastOk.get(url);
    if (last !== undefined && Date.now() - last < 30_000) return true;
    const known = last !== undefined;
    const tryInfo = async (limitMs: number): Promise<boolean> => {
      const t0 = performance.now();
      try {
        const r = await this.#request(url, "GET", "/info", undefined, undefined, 0, Math.max(1, Math.min(1_000, limitMs)));
        return !r.error;
      } finally {
        budget.spentMs += performance.now() - t0;
      }
    };
    if (await tryInfo(1_000)) return true; // always one try, even when the budget is spent
    if (!known) return false;
    for (;;) {
      const left = INFO_PROBE_BUDGET_MS - budget.spentMs;
      if (left <= 0) return false;
      const t0 = performance.now();
      await new Promise((res) => setTimeout(res, Math.min(250, left)));
      budget.spentMs += performance.now() - t0;
      const rest = INFO_PROBE_BUDGET_MS - budget.spentMs;
      if (rest <= 0) return false;
      if (await tryInfo(rest)) return true;
    }
  }

  async #authed(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    waitSeconds: number,
    preferred?: string,
    probeKey?: string,
  ): Promise<{ data: unknown; url: string }> {
    if (!this.#token) {
      throw new AuthenticationError({ status: 0, code: "unauthenticated", message: "No token: pass { token } or call pair() first." });
    }
    const order = preferred ? [preferred, ...this.#stations.filter((s) => s !== preferred)] : this.#stations;
    const attempts: StationAttempt[] = [];
    const infoBudget: InfoBudget = { spentMs: 0 }; // one per call (one print()), shared by all stations
    let refreshed = false;
    for (const url of order) {
      let r = await this.#request(url, method, path, this.#token, body, waitSeconds);
      // Only an expired token is refreshed; a device revoked at the station stays revoked.
      if (r.error instanceof AuthenticationError && r.error.code === "token_expired" && !refreshed && this.#o.refreshToken) {
        refreshed = true;
        const t = await this.#o.refreshToken();
        if (t) {
          this.#token = t;
          r = await this.#request(url, method, path, t, body, waitSeconds);
        }
      }
      let postInProgress = false;
      if (probeKey !== undefined && r.error?.status === 409 && r.error.code === "in_progress") {
        r = { ...r, unreachable: true, noAnswer: true }; // still processing: probe (Q1)
        postInProgress = true;
      }
      if (!r.error && probeKey !== undefined && !(r.data as { id?: unknown } | undefined)?.id) {
        // A 2xx without a usable job: the station may have it (C5).
        r = { error: new CatzPrintError({ status: 201, code: "invalid_response", message: "The station answered without a job." }), unreachable: true, noAnswer: true };
      }
      if (r.networkError && probeKey !== undefined && (await this.#recentlyReachable(url, infoBudget))) {
        // Browsers can't tell "refused" from "reset after sending": a station
        // that just answered (or answers now) may have the job (R2).
        r = { ...r, noAnswer: true };
      }
      if (r.noAnswer && probeKey !== undefined) {
        // Sent, but the answer was lost: ask the same station by key; never
        // send the job anywhere else while that is unknown.
        const pr = await this.#probe(url, probeKey);
        if (pr.found !== undefined) return { data: pr.found, url };
        if (pr.conflict) throw pr.conflict; // 409 duplicate: an answer, no fallback
        // After a POST answered in_progress, a 404 doesn't mean "never recorded" (S4).
        if (!pr.notFound || postInProgress) throw new OutcomeUnknownError(url, probeKey, r.error);
        attempts.push({ url, error: r.error });
        continue;
      }
      if (r.noAnswer && r.error?.code === "response_too_large") throw r.error;
      if (!r.error) return { data: r.data, url };
      if (r.unreachable) {
        attempts.push({ url, error: r.error });
        continue;
      }
      throw r.error;
    }
    throw new StationUnreachableError(attempts);
  }

  /**
   * One request. Browsers don't say whether a failed request was sent, so a
   * fetch error (connection refused, DNS, certificate) counts as not
   * delivered, while a timeout, a redirect, an unreadable or too-large
   * answer counts as "sent, no answer" (`noAnswer`).
   */
  async #request(
    url: string,
    method: "GET" | "POST",
    path: string,
    token?: string,
    body?: unknown,
    waitSeconds = 0,
    timeoutOverrideMs?: number,
  ): Promise<{ data?: unknown; error?: CatzPrintError; unreachable: boolean; noAnswer: boolean; networkError?: boolean }> {
    const timeoutMs = timeoutOverrideMs ?? (this.#o.timeoutMs ?? 15_000) + waitSeconds * 1000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const lost = (error: CatzPrintError) => ({ error, unreachable: true, noAnswer: true });
    let res: Response;
    try {
      res = await this.#fetch(url + LOCAL_API + path, {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
        signal: ctrl.signal,
        redirect: "manual",
      });
    } catch (err) {
      clearTimeout(timer);
      const timedOut = ctrl.signal.aborted;
      const error = connectionError(err, timedOut, timeoutMs);
      return timedOut ? lost(error) : { error, unreachable: true, noAnswer: false, networkError: true };
    }
    // Any HTTP answer shows the station is reachable (used after a later network error).
    this.#lastOk.set(url, Date.now());
    let text = "";
    try {
      text = await readCapped(res, MAX_LOCAL_RESPONSE);
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof TooLargeBody) {
        return lost(new CatzPrintError({ status: res.status, code: "response_too_large", message: `The station's answer is larger than ${MAX_LOCAL_RESPONSE} bytes.` }));
      }
      return lost(connectionError(err, ctrl.signal.aborted, timeoutMs));
    }
    clearTimeout(timer);
    let data: unknown;
    let parsed = true;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = false;
    }
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      return lost(stationError(res.status || 302, undefined, res.headers));
    }
    if (res.ok) {
      if (!parsed) return lost(new CatzPrintError({ status: res.status, code: "invalid_response", message: "The station returned a response that isn't JSON." }));
      return { data, unreachable: false, noAnswer: false };
    }
    const error = stationError(res.status, parsed ? data : undefined, res.headers);
    return { error, unreachable: isUnreachableAnswer(res.status, error.code), noAnswer: false };
  }
}

class TooLargeBody extends Error {}

/** The /info probing time spent so far in one print() (all stations). */
interface InfoBudget {
  spentMs: number;
}

/**
 * How long one print() may spend on extra /info tries after network errors
 * (each failed station's first try always happens).
 */
const INFO_PROBE_BUDGET_MS = 5_000;

/** Reads a body as text, refusing more than `limit` bytes. */
async function readCapped(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    void res.body?.cancel().catch(() => {}); // don't wait: a cancel can stall
    throw new TooLargeBody();
  }
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      void reader.cancel().catch(() => {}); // don't wait: a cancel can stall
      throw new TooLargeBody();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export default CatzPrintLocal;
