import { createHmac, timingSafeEqual } from "node:crypto";
import { SignatureVerificationError } from "./errors.js";
import type { WebhookEvent } from "./types.js";

/** Name of the HTTP header that carries the signature. */
export const SIGNATURE_HEADER = "CatzPrint-Signature";

/** Default tolerance for the signed timestamp, in seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type WebhookPayload = string | Uint8Array | ArrayBuffer;

export interface VerifyOptions {
  /** Max age (and max clock skew) of the signature, in seconds. Default 300. 0 or less disables the check. */
  tolerance?: number;
  /** Current time in seconds since the epoch; for tests. */
  now?: number;
}

function toBuffer(payload: WebhookPayload): Buffer {
  if (typeof payload === "string") return Buffer.from(payload, "utf8");
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  if (payload instanceof Uint8Array) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  throw new SignatureVerificationError(
    "Webhook payload must be the raw request body (string or bytes), not a parsed object. " +
      "In Express use express.raw({ type: 'application/json' }).",
  );
}

/** The HMAC-SHA256 hex signature for a timestamp and body, as CatzPrint computes it. */
export function computeSignature(payload: WebhookPayload, secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(toBuffer(payload)).digest("hex");
}

/** Builds a `CatzPrint-Signature` header value. Useful for testing your webhook handler. */
export function generateTestHeader(opts: { payload: WebhookPayload; secret: string; timestamp?: number }): string {
  const t = opts.timestamp ?? Math.floor(Date.now() / 1000);
  return `t=${t},v1=${computeSignature(opts.payload, opts.secret, t)}`;
}

function parseHeader(header: string): { timestamp: number; signatures: string[] } {
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === "t") {
      if (!/^\d{1,15}$/.test(value)) throw new SignatureVerificationError("Signature header has an invalid timestamp.", header);
      timestamp = Number(value);
    } else if (key === "v1") {
      signatures.push(value);
    }
  }
  if (timestamp === undefined) throw new SignatureVerificationError("Signature header has no timestamp (t=).", header);
  if (signatures.length === 0) throw new SignatureVerificationError("Signature header has no v1 signature.", header);
  return { timestamp, signatures };
}

/**
 * Checks a webhook signature without parsing the body. Throws
 * SignatureVerificationError when it doesn't match or is outside tolerance.
 */
export function verifySignature(
  payload: WebhookPayload,
  header: string | string[] | null | undefined,
  secret: string,
  options: VerifyOptions = {},
): void {
  const h = Array.isArray(header) ? header.join(",") : header;
  if (!h) throw new SignatureVerificationError(`Missing ${SIGNATURE_HEADER} header.`);
  if (!secret) throw new SignatureVerificationError("Webhook secret is empty.", h);
  const { timestamp, signatures } = parseHeader(h);
  // A tolerance that isn't a number (e.g. NaN from a bad config value) must
  // not silently turn the replay check off.
  const tolerance =
    typeof options.tolerance === "number" && !Number.isNaN(options.tolerance)
      ? options.tolerance
      : DEFAULT_TOLERANCE_SECONDS;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (tolerance > 0 && Math.abs(now - timestamp) > tolerance) {
    throw new SignatureVerificationError("Signature timestamp is outside the tolerance window.", h);
  }
  const expected = Buffer.from(computeSignature(payload, secret, timestamp), "hex");
  let ok = false;
  for (const sig of signatures) {
    if (!/^[0-9a-fA-F]{64}$/.test(sig)) continue;
    const got = Buffer.from(sig, "hex");
    // Compare every candidate so timing doesn't reveal which one matched.
    if (timingSafeEqual(got, expected)) ok = true;
  }
  if (!ok) throw new SignatureVerificationError("No signature matches the payload. Check the secret and use the raw body.", h);
}

/**
 * Verifies a webhook delivery and returns the parsed event.
 *
 * @param payload The raw request body, exactly as received.
 * @param header  The `CatzPrint-Signature` header.
 * @param secret  The endpoint's signing secret (shown once when you create it).
 */
export function verify<T = Record<string, unknown>>(
  payload: WebhookPayload,
  header: string | string[] | null | undefined,
  secret: string,
  options: VerifyOptions | number = {},
): WebhookEvent<T> {
  const opts = typeof options === "number" ? { tolerance: options } : options;
  verifySignature(payload, header, secret, opts);
  try {
    return JSON.parse(toBuffer(payload).toString("utf8")) as WebhookEvent<T>;
  } catch {
    throw new SignatureVerificationError("Webhook payload is signed but isn't valid JSON.");
  }
}

/** Webhook helpers. `constructEvent` is an alias of `verify`. */
export const webhooks = {
  verify,
  constructEvent: verify,
  verifySignature,
  computeSignature,
  generateTestHeader,
  SIGNATURE_HEADER,
} as const;

export type Webhooks = typeof webhooks;
