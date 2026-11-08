// How a cloud create attempt went, and the 409 re-send loop (SDK addenda 2
// and 3). Shared by the local fallback modes and plain cloud creates.
import { CatzPrintError, ConnectionError, OutcomeUnknownError, ServerError, ValidationError } from "../errors.js";
import { isNotSent } from "./shared.js";

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** The cloud surely doesn't have the job: never sent, or 502/503/504 from the edge. */
export function cloudNotDelivered(err: unknown): boolean {
  if (err instanceof OutcomeUnknownError) return false; // the cloud may have the job
  if (isNotSent(err)) return true;
  if (err instanceof ConnectionError) return err.delivered === false;
  return err instanceof ServerError && (err.status === 502 || err.status === 503 || err.status === 504);
}

/** The cloud may have the job: sent with no usable answer, a 500, a redirect, an unreadable answer. */
export function cloudAmbiguous(err: unknown): boolean {
  if (err instanceof OutcomeUnknownError || isNotSent(err)) return false;
  if (err instanceof ConnectionError) return err.delivered !== false;
  if (!(err instanceof CatzPrintError)) return false;
  if (err.status >= 500) return !cloudNotDelivered(err);
  if (err.status >= 300 && err.status < 400) return true;
  return err.code === "response_too_large" || err.code === "invalid_response" || err.code === "unexpected_redirect";
}

/** A 409 saying a job with this key exists or is being created right now. */
export function isConflictInProgress(err: unknown): boolean {
  return err instanceof CatzPrintError && err.status === 409 && (err.code === "duplicate" || /being created/i.test(err.message));
}

/**
 * A 400/422 saying the API couldn't use `sealed_content` (usually: the server
 * key was rotated after the SDK fetched it).
 */
export function sealedRejected(err: unknown): boolean {
  return err instanceof ValidationError && Object.prototype.hasOwnProperty.call(err.fields ?? {}, "sealed_content");
}

export function sentAndLost(err: unknown): boolean {
  return err instanceof ConnectionError && err.delivered === true;
}

/**
 * Re-sends an identical create after a 409 in progress: up to 3 times, 1 s
 * apart. A 409 that is still there afterwards is the cloud's (definite) answer
 * and is thrown; only a re-send that isn't delivered or is ambiguous becomes
 * OutcomeUnknownError. Cancelled while waiting (nothing sent): the cancellation.
 */
export async function resendWhileInProgress<J>(
  once: () => Promise<J>,
  err: unknown,
  unknown: (e: unknown) => Error,
  signal?: AbortSignal,
): Promise<J> {
  for (let i = 0; i < 3; i++) {
    await sleep(1000, signal);
    try {
      return await once();
    } catch (e) {
      err = e;
    }
    if (signal?.aborted) {
      if (sentAndLost(err)) throw unknown(signal.reason);
      throw signal.reason;
    }
    if (isConflictInProgress(err)) continue;
    // A job with this key exists or is being created: an answer that isn't
    // the job leaves the outcome open.
    if (cloudAmbiguous(err) || cloudNotDelivered(err) || sealedRejected(err)) throw unknown(err);
    throw err;
  }
  throw err; // still 409: the cloud's answer
}
