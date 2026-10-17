import { ConnectionError, CatzPrintError, errorFromResponse } from "./errors.js";
import { VERSION } from "./version.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  /** Longest Retry-After (seconds) the SDK will sleep through before giving up. */
  maxRetryAfterSeconds: number;
  fetch: FetchLike;
  userAgent?: string;
  /** Hook for tests: replaces setTimeout-based sleeping. */
  sleep?: (ms: number) => Promise<void>;
  /** Hook for tests: replaces Math.random for jitter. */
  random?: () => number;
}

export interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /**
   * The call is safe to repeat. GETs always are; a POST only when it carries
   * an idempotency key the API honours.
   */
  idempotent?: boolean;
  /** Overrides the client's API key (sent as Bearer). */
  token?: string;
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);

/** Largest response body the SDK reads (64 MiB); anything bigger is an error. */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

class ResponseTooLarge extends Error {}

/** Reads a response body as text, refusing more than `limit` bytes. */
async function readText(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => {});
    throw new ResponseTooLarge();
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
      await reader.cancel().catch(() => {});
      throw new ResponseTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

/** Exponential backoff with full jitter: 0.5s, 1s, 2s … capped at 8s. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(8000, 500 * 2 ** attempt);
  return Math.round(base / 2 + random() * (base / 2));
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class HttpClient {
  readonly #o: HttpOptions;

  constructor(options: HttpOptions) {
    this.#o = options;
  }

  get baseUrl(): string {
    return this.#o.baseUrl;
  }

  url(path: string, query?: RequestOptions["query"]): string {
    const u = new URL(this.#o.baseUrl.replace(/\/+$/, "") + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  async request<T>(opts: RequestOptions): Promise<T> {
    const o = this.#o;
    const sleep = o.sleep ?? defaultSleep;
    const random = o.random ?? Math.random;
    const idempotent = opts.idempotent ?? (opts.method === "GET" || opts.method === "DELETE" || opts.method === "PUT");
    const maxRetries = idempotent ? (opts.maxRetries ?? o.maxRetries) : 0;
    const timeoutMs = opts.timeoutMs ?? o.timeoutMs;
    const url = this.url(opts.path, opts.query);
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${opts.token ?? o.apiKey}`,
      "User-Agent": o.userAgent ?? `catzprint-node/${VERSION}`,
    };
    let payload: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(opts.body);
    }

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
      const onAbort = () => ctrl.abort(opts.signal?.reason);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        // Never follow redirects: the Authorization header must only ever go to
        // the configured API host.
        res = await o.fetch(url, {
          method: opts.method,
          headers,
          body: payload ?? null,
          signal: ctrl.signal,
          redirect: "manual",
        });
      } catch (err) {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        if (opts.signal?.aborted) throw err;
        const timedOut = ctrl.signal.aborted;
        if (attempt < maxRetries) {
          await sleep(backoffMs(attempt, random));
          continue;
        }
        throw new ConnectionError({
          status: 0,
          code: timedOut ? "timeout" : "connection_error",
          message: timedOut
            ? `The request timed out after ${timeoutMs} ms.`
            : `Couldn't reach the CatzPrint API: ${(err as Error)?.message ?? String(err)}`,
          cause: err,
        });
      }

      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        await res.body?.cancel().catch(() => {});
        throw new CatzPrintError({
          status: res.status,
          code: "unexpected_redirect",
          message: "The API answered with a redirect, which the SDK doesn't follow. Check the base URL.",
        });
      }

      let text: string;
      try {
        text = await readText(res, MAX_RESPONSE_BYTES);
      } catch (err) {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        if (err instanceof ResponseTooLarge) {
          throw new CatzPrintError({
            status: res.status,
            code: "response_too_large",
            message: `The API response is larger than ${MAX_RESPONSE_BYTES} bytes.`,
          });
        }
        if (attempt < maxRetries) {
          await sleep(backoffMs(attempt, random));
          continue;
        }
        throw new ConnectionError({ status: 0, code: "connection_error", message: "The response was cut off.", cause: err });
      }
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);

      let data: unknown = undefined;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = undefined;
        }
      }
      if (res.ok) {
        if (text && data === undefined) {
          throw new CatzPrintError({ status: res.status, code: "invalid_response", message: "The API returned a response that isn't JSON." });
        }
        return data as T;
      }

      const error = errorFromResponse(res.status, data, res.headers);
      if (attempt < maxRetries && RETRY_STATUSES.has(res.status)) {
        let wait = backoffMs(attempt, random);
        if (error.retryAfter !== undefined) {
          if (error.retryAfter > o.maxRetryAfterSeconds) throw error;
          wait = Math.max(wait, error.retryAfter * 1000);
        }
        await sleep(wait);
        continue;
      }
      throw error;
    }
  }
}
