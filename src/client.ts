import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { AuthenticationError } from "./errors.js";
import { HttpClient, type FetchLike } from "./http.js";
import { sealBox } from "./nacl.js";
import { Jobs, toUint8, type Bytes, type CreateJobParams, type JobTarget } from "./resources/jobs.js";
import { Locations } from "./resources/locations.js";
import { Printers } from "./resources/printers.js";
import { Templates } from "./resources/templates.js";
import type { ApiKeyInfo, EscposCommand, Job, ServerKey } from "./types.js";
import { VERSION } from "./version.js";
import { webhooks, type Webhooks } from "./webhooks.js";

export const DEFAULT_BASE_URL = "https://api-v1.catzprint.com";

export interface ClientOptions {
  /** `cz_live_…` or `cz_test_…`. Defaults to the CATZPRINT_API_KEY environment variable. */
  apiKey?: string;
  /** Defaults to CATZPRINT_BASE_URL, then https://api-v1.catzprint.com. */
  baseUrl?: string;
  /** Your organization ID. Looked up from the key (`GET /v1/key`) on first use when omitted. */
  orgId?: string;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** Retries for network errors, 429 and 502/503/504 on safe requests. Default 2. */
  maxRetries?: number;
  /** Don't wait longer than this for a Retry-After (seconds); throw instead. Default 60. */
  maxRetryAfterSeconds?: number;
  /** Custom fetch (defaults to the global fetch). */
  fetch?: FetchLike;
}

/** Options for the print helpers: where to print, plus `sealed`. */
export interface PrintOptions extends JobTarget {
  /** Encrypt the content to the server key before sending (text, PDF, image). */
  sealed?: boolean;
}

/** A file path, or the bytes themselves. */
export type FileSource = string | Bytes;

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

function env(name: string): string | undefined {
  const v = typeof process !== "undefined" ? process.env?.[name] : undefined;
  return v ? v : undefined;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Checks the API base URL. The API key travels in every request, so the URL
 * must be https; plain http is accepted only for a local server (tests,
 * development proxies). Returns the URL without a trailing slash.
 */
export function checkBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new TypeError(`The CatzPrint base URL isn't a valid URL: ${JSON.stringify(trimmed)}`);
  }
  if (u.username || u.password) {
    throw new TypeError("The CatzPrint base URL must not contain credentials.");
  }
  if (u.search || u.hash) {
    throw new TypeError("The CatzPrint base URL must not contain a query or fragment.");
  }
  const local = LOCAL_HOSTS.has(u.hostname) || u.hostname.endsWith(".localhost");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new TypeError(
      "The CatzPrint base URL must use https:// (http:// is allowed only for localhost), so the API key isn't sent in clear text.",
    );
  }
  return trimmed;
}

/** Hides all but the key's mode prefix. */
export function redactKey(key: string): string {
  const m = /^(cz_(?:live|test)_)/.exec(key);
  return (m ? m[1] : "") + "****";
}

/**
 * The CatzPrint API client.
 *
 * ```ts
 * const cz = new CatzPrint({ apiKey: process.env.CATZPRINT_API_KEY });
 * const job = await cz.printText("Hello!", { printerId });
 * ```
 */
export class CatzPrint {
  /** Print jobs. */
  readonly jobs: Jobs;
  /** Printers (read-only). */
  readonly printers: Printers;
  /** Locations (read-only). */
  readonly locations: Locations;
  /** Saved receipt templates. */
  readonly templates: Templates;
  /** Webhook signature verification (no API key needed). */
  readonly webhooks: Webhooks = webhooks;
  /** The API base URL in use. */
  readonly baseUrl: string;

  readonly #apiKey: string;
  readonly #http: HttpClient;
  #orgId: string | undefined;
  #keyInfo: Promise<ApiKeyInfo> | undefined;
  #serverKey: Promise<Uint8Array> | undefined;

  static readonly VERSION = VERSION;

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? env("CATZPRINT_API_KEY");
    if (!apiKey) {
      throw new AuthenticationError({
        status: 0,
        code: "missing_api_key",
        message: "No API key. Pass { apiKey } or set CATZPRINT_API_KEY.",
      });
    }
    if (!/^cz_(live|test)_/.test(apiKey)) {
      throw new AuthenticationError({
        status: 0,
        code: "invalid_api_key",
        message: "API keys start with cz_live_ or cz_test_.",
      });
    }
    const fetchFn = options.fetch ?? (globalThis.fetch?.bind(globalThis) as FetchLike | undefined);
    if (!fetchFn) throw new Error("No fetch available. Use Node 18+ or pass { fetch }.");
    this.#apiKey = apiKey;
    this.#orgId = options.orgId;
    this.baseUrl = checkBaseUrl(options.baseUrl ?? env("CATZPRINT_BASE_URL") ?? DEFAULT_BASE_URL);
    this.#http = new HttpClient({
      apiKey,
      baseUrl: this.baseUrl,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxRetries: options.maxRetries ?? 2,
      maxRetryAfterSeconds: options.maxRetryAfterSeconds ?? 60,
      fetch: fetchFn,
    });
    const orgId = () => this.orgId();
    this.jobs = new Jobs({
      http: this.#http,
      orgId,
      seal: async (content) => Buffer.from(sealBox(content, await this.serverPublicKey())).toString("base64"),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    this.printers = new Printers(this.#http, orgId);
    this.locations = new Locations(this.#http, orgId);
    this.templates = new Templates(this.#http, orgId);
  }

  /** "live" or "test", from the key's prefix. Test keys never bill and never print on paper. */
  get mode(): "live" | "test" {
    return this.#apiKey.startsWith("cz_test_") ? "test" : "live";
  }

  /** The API key in use: its org, mode and scopes (`GET /v1/key`). Cached. */
  async key(): Promise<ApiKeyInfo> {
    if (!this.#keyInfo) {
      this.#keyInfo = this.#http.request<ApiKeyInfo>({ method: "GET", path: "/v1/key" });
      this.#keyInfo.catch(() => {
        this.#keyInfo = undefined;
      });
    }
    return this.#keyInfo;
  }

  /** Alias of `key()`. */
  whoami(): Promise<ApiKeyInfo> {
    return this.key();
  }

  /** The organization ID, from the constructor or looked up once from the key. */
  async orgId(): Promise<string> {
    if (this.#orgId) return this.#orgId;
    const k = await this.key();
    this.#orgId = k.org_id;
    return k.org_id;
  }

  /** The server's public key (`GET /v1/public/server-key`). Cached. */
  async serverKey(): Promise<ServerKey> {
    const res = await this.#http.request<ServerKey>({ method: "GET", path: "/v1/public/server-key" });
    this.#serverKey = Promise.resolve(decodeServerKey(res));
    return res;
  }

  /** The raw 32-byte server public key, fetched once and cached. */
  async serverPublicKey(): Promise<Uint8Array> {
    if (!this.#serverKey) {
      this.#serverKey = this.#http
        .request<ServerKey>({ method: "GET", path: "/v1/public/server-key" })
        .then(decodeServerKey);
      this.#serverKey.catch(() => {
        this.#serverKey = undefined;
      });
    }
    return this.#serverKey;
  }

  /** Seals bytes to the server key; returns base64 for `sealed_content`. */
  async seal(content: Bytes): Promise<string> {
    return Buffer.from(sealBox(toUint8(content), await this.serverPublicKey())).toString("base64");
  }

  // ---- print helpers ----

  /** Prints plain text. Receipt printers print it as-is; office printers get a PDF. */
  printText(text: string, options: PrintOptions = {}): Promise<Job> {
    return this.jobs.create({ ...options, text });
  }

  /** Prints a PDF from a file path or bytes. Needs a printer that takes PDFs. */
  async printPdf(source: FileSource, options: PrintOptions = {}): Promise<Job> {
    const { bytes, name } = await readSource(source);
    return this.jobs.create({ title: name, ...options, kind: "pdf", content: bytes });
  }

  /** Prints a PNG or JPEG from a file path or bytes. */
  async printImage(source: FileSource, options: PrintOptions = {}): Promise<Job> {
    const { bytes, name } = await readSource(source);
    return this.jobs.create({ title: name, ...options, kind: "image", content: bytes });
  }

  /** Prints a receipt from ESC/POS commands. */
  printReceipt(commands: EscposCommand[], options: JobTarget = {}): Promise<Job> {
    return this.jobs.create({ ...options, commands });
  }

  /** Prints a saved template with data. */
  printTemplate(templateId: string, data: Record<string, unknown> = {}, options: JobTarget = {}): Promise<Job> {
    return this.jobs.create({ ...options, templateId, data });
  }

  /** Creates any kind of job. Same as `jobs.create`. */
  print(params: CreateJobParams): Promise<Job> {
    return this.jobs.create(params);
  }

  toJSON(): Record<string, unknown> {
    return { baseUrl: this.baseUrl, apiKey: redactKey(this.#apiKey), orgId: this.#orgId };
  }

  toString(): string {
    return `CatzPrint(${redactKey(this.#apiKey)} @ ${this.baseUrl})`;
  }

  [INSPECT](): string {
    return this.toString();
  }
}

/** Decodes and checks the 32-byte X25519 key from `GET /v1/public/server-key`. */
function decodeServerKey(res: ServerKey): Uint8Array {
  const b64 = typeof res?.public_key === "string" ? res.public_key.trim() : "";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(b64)) throw new Error("The server returned a malformed public key.");
  const raw = new Uint8Array(Buffer.from(b64, "base64"));
  if (raw.length !== 32 || raw.every((b) => b === 0)) throw new Error("The server returned a malformed public key.");
  return raw;
}

async function readSource(source: FileSource): Promise<{ bytes: Uint8Array; name: string | undefined }> {
  if (typeof source === "string") {
    return { bytes: new Uint8Array(await readFile(source)), name: basename(source) };
  }
  return { bytes: toUint8(source), name: undefined };
}
