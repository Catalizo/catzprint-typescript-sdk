// Helpers shared by the Node client and the browser entry. Browser-safe: no
// Node built-ins, no Buffer, no process.
import { CatzPrintError, ConnectionError, ValidationError, errorFromResponse } from "../errors.js";
import type { LocalJob, LocalPairing, LocalPrintParams } from "./types.js";

export const LOCAL_API = "/local/v1";

/** Checks a station URL (https only, just scheme://host:port) and normalizes it. */
export function normalizeStationUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new TypeError(`Station URL ${JSON.stringify(raw)} isn't a valid URL.`);
  }
  if (u.protocol !== "https:") throw new TypeError(`Station URL ${JSON.stringify(raw)} must use https://.`);
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) {
    throw new TypeError(`Station URL ${JSON.stringify(raw)} must be just https://host:port.`);
  }
  return `https://${u.host.toLowerCase()}`;
}

/** Lower-case hex SHA-256 (colons/spaces allowed in input), or "" when malformed. */
export function normalizeFingerprint(fp: string | undefined | null): string {
  const s = String(fp ?? "")
    .trim()
    .replace(/[:\s-]/g, "")
    .toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : "";
}

/** `"sdk-" + UUID v4`, from WebCrypto. */
export function sdkIdempotencyKey(randomUUID?: () => string): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (randomUUID) return `sdk-${randomUUID()}`;
  if (c?.randomUUID) return `sdk-${c.randomUUID()}`;
  if (!c?.getRandomValues) throw new Error("No secure random source (WebCrypto) available.");
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `sdk-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Does this answer mean "this station can't be used now" (move on / fall
 * back), rather than an answer to return? 502/504, 503 local_disabled, a 503
 * that isn't a station error, and redirects.
 */
export function isUnreachableAnswer(status: number, code: string): boolean {
  if (status === 502 || status === 504) return true;
  if (status === 503 && (code === "local_disabled" || code === "server_error" || code === "http_503")) return true;
  return status >= 300 && status < 400;
}

/** Turns camelCase print params into the station's JSON body. */
export function localBody(p: LocalPrintParams, idempotencyKey: string): Record<string, unknown> {
  let kind = p.kind;
  let content = p.content;
  if (p.text !== undefined) {
    if (content !== undefined) throw new TypeError("Pass text or content, not both.");
    content = p.text;
    kind ??= "text";
  }
  if (kind === undefined) {
    if (p.commands !== undefined) kind = "commands";
    else if (p.templateId !== undefined) kind = "template";
  }
  const body: Record<string, unknown> = {
    printer_id: p.printerId,
    location_id: p.locationId,
    role: p.role,
    kind,
    commands: p.commands,
    template_id: p.templateId,
    data: p.templateId !== undefined ? (p.data ?? {}) : p.data,
    content,
    title: p.title,
    reference: p.reference,
    copies: p.copies,
    idempotency_key: idempotencyKey,
    options: p.options,
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

/** Builds the SDK error for a station's non-2xx answer. */
export function stationError(status: number, data: unknown, headers?: { get(name: string): string | null }): CatzPrintError {
  return errorFromResponse(status, data, headers);
}

export function connectionError(err: unknown, timedOut: boolean, timeoutMs: number): ConnectionError {
  return new ConnectionError({
    status: 0,
    code: timedOut ? "timeout" : "connection_error",
    message: timedOut
      ? `The station didn't answer within ${timeoutMs} ms.`
      : `Couldn't reach the station: ${(err as Error)?.message ?? String(err)}`,
    cause: err,
  });
}

export function toPairing(res: Record<string, unknown>): LocalPairing {
  if (typeof res?.token !== "string" || !res.token) {
    throw new CatzPrintError({ status: 201, code: "invalid_response", message: "The station answered without a token." });
  }
  return hideToken({
    token: res.token,
    deviceId: String(res.device_id ?? ""),
    stationId: String(res.station_id ?? ""),
    orgId: String(res.org_id ?? ""),
    locationId: String(res.location_id ?? ""),
  });
}

export function checkPairingCode(code: string): void {
  if (!/^\d{8}$/.test(String(code))) {
    throw new TypeError("The pairing code is the 8 digits shown in the station app.");
  }
}

export function withStation<T extends LocalJob>(job: T, url: string): T {
  return { ...job, station_url: url };
}

/**
 * A key that is blank after trimming means "no key" (undefined). Keys with
 * leading/trailing whitespace or control characters are refused, never
 * silently changed.
 */
export function checkIdempotencyKey(k: string | undefined | null): string | undefined {
  if (k === undefined || k === null || String(k).trim() === "") return undefined;
  const key = String(k);
  let why: string | undefined;
  if (key !== key.trim()) why = "The idempotency key must not start or end with whitespace.";
  // eslint-disable-next-line no-control-regex
  else if (/[\u0000-\u001f\u007f-\u009f]/.test(key)) why = "The idempotency key must not contain control characters.";
  if (why) throw new ValidationError({ status: 0, code: "invalid", message: why, fields: { idempotency_key: why } });
  return key;
}

/** A token's type prefix only, for display. */
export function redactToken(t: unknown): string {
  if (typeof t !== "string" || !t) return "";
  if (t.startsWith("czl1.")) return "czl1.…";
  if (t.startsWith("czd_")) return "czd_…";
  return "…";
}

/**
 * Is `t` a redaction placeholder rather than a token? `…`, a run of 3+ `*`,
 * `[redacted]`, `redacted` or `hidden` (any case), optionally after `czl1.` or
 * `czd_`. Every CatzPrint SDK recognises the same set.
 */
export function isRedactedToken(t: unknown): boolean {
  return typeof t === "string" && /^(czl1\.|czd_)?(…|\*{3,}|\[redacted\]|redacted|hidden)$/i.test(t);
}

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * Keeps `token` a normal property (JSON.stringify includes it: backends hand
 * tokens to browser tills) but redacts it in console.log / util.inspect and
 * toString.
 */
export function hideToken<T extends { token?: unknown }>(obj: T): T {
  if (!obj || typeof obj !== "object") return obj;
  const view = () => ({ ...obj, token: redactToken(obj.token) });
  Object.defineProperty(obj, INSPECT, {
    value: (_depth: number, options: unknown, inspect?: (v: unknown, o: unknown) => string) =>
      inspect ? inspect(view(), options) : JSON.stringify(view()),
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(obj, "toString", { value: () => JSON.stringify(view()), enumerable: false, configurable: true });
  return obj;
}

/** Largest station answer the SDK reads (4 MiB). */
export const MAX_LOCAL_RESPONSE = 4 * 1024 * 1024;

const NOT_SENT = Symbol.for("catzprint.notSent");

/** Marks an error raised before the job request was sent (e.g. the org-ID lookup). */
export function markNotSent<E>(err: E): E {
  if (err && typeof err === "object") Object.defineProperty(err, NOT_SENT, { value: true, enumerable: false, configurable: true });
  return err;
}

/** Was this error raised before the job request was sent? */
export function isNotSent(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as Record<symbol, unknown>)[NOT_SENT] === true;
}
