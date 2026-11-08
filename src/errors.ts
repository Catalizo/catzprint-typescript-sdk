/** Fields the API reports as invalid, keyed by request field name. */
export type FieldErrors = Record<string, string>;

export interface CatzPrintErrorInit {
  status: number;
  code: string;
  message: string;
  fields?: FieldErrors;
  retryAfter?: number | undefined;
  requestId?: string | undefined;
  cause?: unknown;
}

/**
 * Base class for every error the SDK throws for an API call.
 *
 * - `status`: HTTP status (0 for network errors)
 * - `code`: stable machine-readable code from the API, e.g. `invalid`, `not_found`
 * - `fields`: per-field messages for validation errors
 * - `retryAfter`: seconds to wait, when the API said so
 */
export class CatzPrintError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: FieldErrors;
  readonly retryAfter: number | undefined;
  readonly requestId: string | undefined;

  constructor(init: CatzPrintErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.status = init.status;
    this.code = init.code;
    this.fields = init.fields ?? {};
    this.retryAfter = init.retryAfter;
    this.requestId = init.requestId;
  }
}

/** 401: the API key is missing, invalid, revoked or expired. */
export class AuthenticationError extends CatzPrintError {}
/** 403: the key lacks a scope, or the action isn't allowed. */
export class PermissionError extends CatzPrintError {}
/** 404: the resource doesn't exist (or isn't in your organization). */
export class NotFoundError extends CatzPrintError {}
/** 400 / 422: the request is invalid; see `fields`. */
export class ValidationError extends CatzPrintError {}
/** 402 / `out_of_prints`: the organization has no prints left this month. */
export class OutOfPrintsError extends CatzPrintError {}
/** 409: conflicting state, e.g. cancelling a printed job. */
export class ConflictError extends CatzPrintError {}
/** 429: too many requests; `retryAfter` says how long to wait. */
export class RateLimitError extends CatzPrintError {}
/** 5xx: the API failed. Safe to retry idempotent calls later. */
export class ServerError extends CatzPrintError {}
/** The request never got an answer: DNS, connection reset, or timeout. */
export class ConnectionError extends CatzPrintError {
  /**
   * True when the request was fully sent before the failure (the server may
   * have acted on it), false when it surely wasn't, undefined when unknown.
   */
  delivered: boolean | undefined;
}

/**
 * A job was sent but its answer was lost, and the SDK couldn't find out
 * whether it was accepted. The SDK stops here (no fallback), because sending
 * it elsewhere could print it twice. Retrying later with the same
 * `idempotencyKey` is always safe. `code` is `"outcome_unknown"`.
 */
export class OutcomeUnknownError extends CatzPrintError {
  /** The station URL (or API base URL) that may have the job. */
  readonly url: string;
  /** The key to retry with. */
  readonly idempotencyKey: string;

  constructor(url: string, idempotencyKey: string, cause?: unknown) {
    super({
      status: 0,
      code: "outcome_unknown",
      message: "The station may have printed this job. Retry later with the same idempotency key.",
      cause,
    });
    this.url = url;
    this.idempotencyKey = idempotencyKey;
  }
}

/** The job may or may not have been accepted (see OutcomeUnknownError). */
export const isOutcomeUnknown = (err: unknown): err is OutcomeUnknownError => err instanceof OutcomeUnknownError;
/**
 * 503 from a CatzPrint station whose printer can't print right now: `code` is
 * `printer_offline`, `out_of_paper`, `cover_open` or `printer_error`. The job
 * was not accepted. The SDK never falls back to the cloud for these.
 */
export class PrinterError extends CatzPrintError {}

/** One station URL the SDK tried, and why it failed. */
export interface StationAttempt {
  url: string;
  error: unknown;
}

/**
 * No CatzPrint station on the local network could take the request: none
 * answered, the TLS check failed, it timed out, a station answered 502/504 or
 * 503 `local_disabled`, or no local token could be obtained.
 *
 * `code` is `"station_unreachable"`. `attempts` lists what was tried. In the
 * fallback modes, `cloudError` is the cloud's error when the cloud failed too.
 */
export class StationUnreachableError extends CatzPrintError {
  readonly attempts: StationAttempt[];
  cloudError: unknown;

  constructor(attempts: StationAttempt[] = [], cloudError?: unknown) {
    super({ status: 0, code: "station_unreachable", message: "No CatzPrint station could be reached." });
    this.attempts = attempts;
    this.cloudError = cloudError;
    // attempts and cloudError are filled in as the SDK goes: compute the
    // message when it is read.
    Object.defineProperty(this, "message", { get: () => this.#describe(), configurable: true, enumerable: false });
  }

  /** The station URLs that were tried, in order. */
  get urls(): string[] {
    return this.attempts.map((a) => a.url).filter((u) => u !== "");
  }

  #describe(): string {
    const parts = this.attempts.map((a) => {
      const why = a.error instanceof Error ? a.error.message : String(a.error);
      return a.url ? `${a.url}: ${why}` : why;
    });
    let m = "No CatzPrint station could be reached";
    m += parts.length ? `: ${parts.join("; ")}` : " (no station address known: set stations or discover)";
    if (this.cloudError !== undefined) {
      const ce = this.cloudError instanceof Error ? this.cloudError.message : String(this.cloudError);
      m += `; cloud fallback failed too: ${ce}`;
    }
    return m + ".";
  }
}

const PRINTER_CODES = new Set(["printer_offline", "out_of_paper", "cover_open", "printer_error"]);

function codeOf(err: unknown): string | undefined {
  return err instanceof CatzPrintError ? err.code : undefined;
}

/** A station refused the job because the routed printer is offline. */
export const isPrinterOffline = (err: unknown): boolean => codeOf(err) === "printer_offline";
/** The printer is out of paper. */
export const isOutOfPaper = (err: unknown): boolean => codeOf(err) === "out_of_paper";
/** The printer's cover is open. */
export const isCoverOpen = (err: unknown): boolean => codeOf(err) === "cover_open";
/** The station has been offline too long or has used its offline prints (402). */
export const isOfflineAllowanceExhausted = (err: unknown): boolean => codeOf(err) === "offline_allowance_exhausted";
/** No station could be reached. */
export const isStationUnreachable = (err: unknown): err is StationUnreachableError => err instanceof StationUnreachableError;

/** A webhook signature header is missing, malformed, wrong, or too old. */
export class SignatureVerificationError extends Error {
  readonly header: string | undefined;
  constructor(message: string, header?: string) {
    super(message);
    this.name = "SignatureVerificationError";
    this.header = header;
  }
}

/** `jobs.waitFor` gave up before the job finished. */
export class TimeoutError extends Error {
  readonly jobId: string;
  /** The job as last seen, if it was fetched at least once. */
  readonly lastJob: unknown;
  constructor(jobId: string, timeoutMs: number, lastJob?: unknown) {
    super(`Job ${jobId} didn't finish within ${Math.round(timeoutMs / 1000)}s.`);
    this.name = "TimeoutError";
    this.jobId = jobId;
    this.lastJob = lastJob;
  }
}

interface ApiErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    fields?: unknown;
    param?: unknown;
    retry_after_seconds?: unknown;
  };
}

/** Builds the right error subclass from an HTTP status and the API's error body. */
export function errorFromResponse(
  status: number,
  body: unknown,
  headers?: { get(name: string): string | null },
): CatzPrintError {
  const e = (body && typeof body === "object" ? (body as ApiErrorBody).error : undefined) ?? {};
  const code = typeof e.code === "string" ? e.code : defaultCode(status);
  const message = typeof e.message === "string" ? e.message : `Request failed with status ${status}.`;
  const fields: FieldErrors = {};
  if (e.fields && typeof e.fields === "object") {
    for (const [k, v] of Object.entries(e.fields as Record<string, unknown>)) fields[k] = String(v);
  }
  if (Object.keys(fields).length === 0 && typeof e.param === "string" && e.param) fields[e.param] = message;
  let retryAfter: number | undefined;
  if (typeof e.retry_after_seconds === "number") retryAfter = e.retry_after_seconds;
  else if (headers) retryAfter = parseRetryAfter(headers.get("retry-after"));
  const init: CatzPrintErrorInit = {
    status,
    code,
    message,
    fields,
    retryAfter,
    requestId: headers?.get("x-request-id") ?? undefined,
  };
  if (status === 402 || code === "out_of_prints") return new OutOfPrintsError(init);
  if (PRINTER_CODES.has(code)) return new PrinterError(init);
  switch (status) {
    case 400:
    case 422:
      return new ValidationError(init);
    case 401:
      return new AuthenticationError(init);
    case 403:
      return new PermissionError(init);
    case 404:
      return new NotFoundError(init);
    case 409:
      return new ConflictError(init);
    case 429:
      return new RateLimitError(init);
  }
  if (status >= 500) return new ServerError(init);
  return new CatzPrintError(init);
}

function defaultCode(status: number): string {
  if (status >= 500) return "server_error";
  return `http_${status}`;
}

/** Parses a Retry-After header (seconds or HTTP date) into seconds. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return n;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.ceil((t - now) / 1000));
}
