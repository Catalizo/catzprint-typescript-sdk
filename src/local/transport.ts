import { X509Certificate, createHash, timingSafeEqual } from "node:crypto";
import { Agent, request as httpsRequest } from "node:https";
import type { ClientRequestArgs, IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import { CatzPrintError } from "../errors.js";
import { MAX_LOCAL_RESPONSE, connectionError, isUnreachableAnswer, stationError } from "./shared.js";

/** A station URL and how to trust it. */
export interface StationTarget {
  url: string;
  /** Lower-case hex SHA-256 of the certificate, or "". */
  fingerprint: string;
  tlsMode: string;
  stationId: string;
  source: "config" | "cloud" | "mdns";
  /** Hex SHA-256 of the public cert's SubjectPublicKeyInfo, pinned on top of normal verification (hostnames from the cloud list). */
  spki?: string;
  /** The station label: dashed-IP hostnames are dialled directly only under it. */
  label?: string;
}

/** A station certificate didn't match the pinned fingerprint. */
export class PinMismatchError extends Error {
  readonly expected: string;
  readonly actual: string;
  /** True when the public-key (SPKI) pin of a public hostname failed. */
  readonly spki: boolean;
  constructor(expected: string, actual: string, spki = false) {
    super(`The station ${spki ? "public key (SPKI)" : "certificate"} fingerprint ${actual} doesn't match the pinned ${expected}.`);
    this.name = "PinMismatchError";
    this.expected = expected;
    this.actual = actual;
    this.spki = spki;
  }
}

/** An IP or self-signed URL without a pinned fingerprint: never trusted on first use. */
export class NoPinError extends Error {
  constructor() {
    super(
      "No pinned certificate fingerprint for this address (IP and self-signed stations are only trusted with the fingerprint from the cloud endpoint list, mDNS or `fingerprints`).",
    );
    this.name = "NoPinError";
  }
}

/** IP addresses, mDNS `.local` names and self-signed stations are trusted by fingerprint only. */
export function needsPin(t: Pick<StationTarget, "url" | "tlsMode">): boolean {
  const host = new URL(t.url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return isIP(host) !== 0 || host.endsWith(".local") || t.tlsMode === "self_signed";
}

/**
 * Decodes the station hostname scheme `<a>-<b>-<c>-<d>.<label>.<zone>` to the
 * private (or loopback) IPv4 it names, so the SDK connects while public DNS
 * is down. Only names under the given label (from the cloud endpoint list)
 * are mapped; the certificate is still verified and its public key pinned.
 */
export function dashedIp(host: string, label: string | undefined): string | undefined {
  const labels = host.toLowerCase().split(".");
  if (labels.length < 3 || !label || labels[1] !== label.toLowerCase()) return undefined;
  const parts = labels[0]!.split("-");
  // No leading zeros ("01" could be read as octal elsewhere).
  if (parts.length !== 4 || !parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255)) return undefined;
  const [a, b] = parts.map(Number) as [number, number];
  const ok = a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  return ok ? parts.join(".") : undefined;
}

/** An https.Agent that verifies the certificate fingerprint before any request byte is sent. */
class StationAgent extends Agent {
  readonly #pin: Buffer | undefined;
  readonly #spki: Buffer | undefined;
  readonly #label: string | undefined;
  readonly #connectTimeoutMs: number;
  readonly #ca: ConnectionOptions["ca"];

  constructor(pin: string, spki: string, label: string | undefined, connectTimeoutMs: number, ca: ConnectionOptions["ca"]) {
    super({ keepAlive: false });
    this.#pin = pin ? Buffer.from(pin, "hex") : undefined;
    this.#spki = !pin && spki ? Buffer.from(spki, "hex") : undefined;
    this.#label = label;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#ca = ca;
  }

  override createConnection(options: ClientRequestArgs, callback?: (err: Error | null, stream: Duplex) => void): Duplex | null | undefined {
    const host = String(options.host ?? options.hostname ?? "localhost").replace(/^\[|\]$/g, "");
    const ip = isIP(host) ? host : dashedIp(host, this.#label);
    const opts: ConnectionOptions = {
      host: ip ?? host,
      port: Number(options.port ?? 443),
      minVersion: "TLSv1.2",
      ALPNProtocols: ["http/1.1"],
    };
    if (this.#pin) {
      // The chain isn't checked against CAs; the leaf must be exactly the pinned one.
      opts.rejectUnauthorized = false;
    } else {
      opts.rejectUnauthorized = true;
      opts.servername = host;
      if (this.#ca) opts.ca = this.#ca;
    }
    let settled = false;
    const finish = (err: Error | null, sock: TLSSocket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) sock.destroy();
      callback?.(err, sock);
    };
    const sock = tlsConnect(opts);
    const timer = setTimeout(() => finish(new Error(`connect timeout after ${this.#connectTimeoutMs} ms`), sock), this.#connectTimeoutMs);
    sock.once("error", (err) => finish(err, sock));
    sock.once("secureConnect", () => {
      if (this.#pin) {
        const raw = sock.getPeerCertificate(false)?.raw;
        const got = raw ? createHash("sha256").update(raw).digest() : Buffer.alloc(0);
        if (got.length !== this.#pin.length || !timingSafeEqual(got, this.#pin)) {
          finish(new PinMismatchError(this.#pin.toString("hex"), got.toString("hex")), sock);
          return;
        }
      }
      if (this.#spki) {
        // After normal verification: the public key must also be the one the
        // cloud reports for this station.
        const raw = sock.getPeerCertificate(false)?.raw;
        let got = Buffer.alloc(0);
        try {
          const der = new X509Certificate(raw).publicKey.export({ type: "spki", format: "der" });
          got = createHash("sha256").update(der).digest();
        } catch {
          // leave empty: mismatch
        }
        if (got.length !== this.#spki.length || !timingSafeEqual(got, this.#spki)) {
          finish(new PinMismatchError(this.#spki.toString("hex"), got.toString("hex"), true), sock);
          return;
        }
      }
      finish(null, sock);
    });
    return undefined;
  }
}

/**
 * How one request went (SDK addendum 2, SDK-1):
 * - `ok` / `answered`: an answer (success, or an error to return);
 * - `not_delivered`: never reached the station (DNS, connect, TLS, pin), or the
 *   station refused it (502/504, 503 local_disabled);
 * - `no_answer`: fully sent, then no usable answer (timeout, reset, body
 *   error, too large, redirect): the station may have it.
 */
export type Outcome = "ok" | "answered" | "not_delivered" | "no_answer";

export interface StationResult<T> {
  data?: T;
  error?: unknown;
  outcome: Outcome;
  /** not_delivered or no_answer. */
  unreachable: boolean;
}

const result = <T>(outcome: Outcome, error?: unknown, data?: T): StationResult<T> => ({
  data,
  error,
  outcome,
  unreachable: outcome === "not_delivered" || outcome === "no_answer",
});

class TooLarge extends Error {}

export class StationTransport {
  readonly #agents = new Map<string, StationAgent>();
  readonly #connectTimeoutMs: number;
  readonly #ca: ConnectionOptions["ca"];
  readonly #userAgent: string;

  constructor(opts: { connectTimeoutMs: number; ca?: ConnectionOptions["ca"]; userAgent: string }) {
    this.#connectTimeoutMs = opts.connectTimeoutMs;
    this.#ca = opts.ca;
    this.#userAgent = opts.userAgent;
  }

  #agent(t: StationTarget): StationAgent {
    const pin = needsPin(t) ? t.fingerprint : "";
    if (needsPin(t) && !pin) throw new NoPinError();
    const key = `${new URL(t.url).host}|${pin}|${t.spki ?? ""}|${t.label ?? ""}`;
    let a = this.#agents.get(key);
    if (!a) {
      a = new StationAgent(pin, t.spki ?? "", t.label, this.#connectTimeoutMs, this.#ca);
      this.#agents.set(key, a);
    }
    return a;
  }

  /**
   * One request to a station (always on a new connection). Never throws for
   * station failures (see `outcome`); throws the abort reason when `signal`
   * aborts.
   */
  async request<T>(
    t: StationTarget,
    method: "GET" | "POST",
    path: string,
    opts: { token?: string; body?: unknown; timeoutMs: number; signal?: AbortSignal },
  ): Promise<StationResult<T>> {
    let agent: StationAgent;
    try {
      agent = this.#agent(t);
    } catch (err) {
      return result("not_delivered", err);
    }
    opts.signal?.throwIfAborted();
    const u = new URL(t.url + path);
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": this.#userAgent };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    const ctrl = new AbortController();
    let timedOut = false;
    let written = false;
    let tooLarge = false; // set before destroying: the reset that follows mustn't look like a lost connection
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort(new Error("timeout"));
    }, opts.timeoutMs);
    const onAbort = () => ctrl.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const { status, text, headers: resHeaders } = await new Promise<{ status: number; text: string; headers: IncomingMessage["headers"] }>(
        (resolve, reject) => {
          const req = httpsRequest(
            {
              protocol: "https:",
              host: u.hostname.replace(/^\[|\]$/g, ""),
              port: u.port || 443,
              path: u.pathname + u.search,
              method,
              headers,
              agent,
              signal: ctrl.signal,
            },
            (res) => {
              written = true; // an answer started: the station got the request
              const chunks: Buffer[] = [];
              let total = 0;
              res.on("data", (c: Buffer) => {
                total += c.length;
                if (total > MAX_LOCAL_RESPONSE) {
                  tooLarge = true;
                  req.destroy(new TooLarge());
                  return;
                }
                chunks.push(c);
              });
              res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
              res.on("error", reject);
            },
          );
          // "finish": the whole request was handed to the (verified) socket.
          req.on("finish", () => {
            written = true;
          });
          req.on("error", reject);
          req.end(payload);
        },
      );
      let data: unknown;
      let parsed = true;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = false;
      }
      if (status >= 200 && status < 300) {
        if (!parsed) {
          return result("no_answer", new CatzPrintError({ status, code: "invalid_response", message: "The station returned a response that isn't JSON." }));
        }
        return result("ok", undefined, data as T);
      }
      const error = stationError(status, parsed ? data : undefined, {
        get: (n: string) => {
          const v = resHeaders[n.toLowerCase()];
          return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
        },
      });
      if (status >= 300 && status < 400) return result("no_answer", error);
      return result(isUnreachableAnswer(status, error.code) ? "not_delivered" : "answered", error);
    } catch (err) {
      if (opts.signal?.aborted) {
        // Cancelled by the caller: after the request was written the station
        // may act on it (the caller turns that into OutcomeUnknownError).
        if (written) return result("no_answer", opts.signal.reason ?? err);
        throw opts.signal.reason ?? err;
      }
      const cause = (err as { cause?: unknown })?.cause;
      if (err instanceof PinMismatchError) return result("not_delivered", err);
      if (cause instanceof PinMismatchError) return result("not_delivered", cause);
      if (tooLarge || err instanceof TooLarge || cause instanceof TooLarge) {
        return result("no_answer", new CatzPrintError({ status: 0, code: "response_too_large", message: `The station's answer is larger than ${MAX_LOCAL_RESPONSE} bytes.` }));
      }
      const ce = connectionError(err, timedOut, opts.timeoutMs);
      ce.delivered = written;
      return result(written ? "no_answer" : "not_delivered", ce);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  close(): void {
    for (const a of this.#agents.values()) a.destroy();
    this.#agents.clear();
  }
}

export function isCatzPrintError(e: unknown): e is CatzPrintError {
  return e instanceof CatzPrintError;
}
