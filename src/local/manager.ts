import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { hostname } from "node:os";
import type { ConnectionOptions } from "node:tls";
import {
  AuthenticationError,
  CatzPrintError,
  ConnectionError,
  OutcomeUnknownError,
  ServerError,
  StationUnreachableError,
  ValidationError,
} from "../errors.js";
import type { CallOverrides, LocalEndpoints, LocalTokens } from "../resources/local.js";
import type { CreateJobParams, Jobs, PreparedCreate } from "../resources/jobs.js";
import type { Job, JobWithEvents } from "../types.js";
import { MDNS_GROUP, MDNS_PORT, type MdnsStation } from "./dns.js";
import { mdnsBrowse, type BrowseTarget } from "./mdns.js";
import { checkPairingCode, isRedactedToken, normalizeFingerprint, normalizeStationUrl, toPairing } from "./shared.js";
import { cloudAmbiguous, cloudNotDelivered, isConflictInProgress, resendWhileInProgress, sealedRejected, sentAndLost, sleep } from "./conflict.js";
export { cloudAmbiguous, cloudNotDelivered, isConflictInProgress } from "./conflict.js";
import { InsecureTokenStoreError, MemoryTokenStore, type StoredToken, type TokenStore } from "./tokenStore.js";
import { StationTransport, needsPin, type StationResult, type StationTarget } from "./transport.js";
import type { LocalEndpoint, LocalInfo, LocalJob, LocalMode, LocalPairing, LocalStatus } from "./types.js";

/** `local` option of `new CatzPrint({ local })`. */
export interface LocalOptions {
  /** cloud (default), local, local_first or cloud_first. */
  mode?: LocalMode;
  /**
   * The location this device prints at: narrows minted tokens and the endpoint
   * list, filters discovered stations, and is used as `locationId` when a job
   * sets neither `printerId` nor `locationId`.
   */
  locationId?: string;
  /** Station URLs to try first, in order (`https://host:port`). */
  stations?: string[];
  /** Out-of-band pins: key = station URL, "host:port" or host; value = hex SHA-256 (colons allowed). */
  fingerprints?: Record<string, string>;
  /**
   * Add stations from the cloud endpoint list (cached, refreshed hourly) and map
   * their station IDs to current addresses with mDNS. mDNS alone is never
   * trusted: only stations on the cloud list (or with a configured fingerprint).
   */
  discover?: boolean;
  /** Mint tokens valid at every location the key may use. By default they are bound to `locationId`, which is then required. */
  allLocations?: boolean;
  /** Keeps the token and endpoint list between runs (default: in memory). */
  tokenStore?: TokenStore;
  /** A fixed token instead of minting: `czd_…` from `local.pair()` or `czl1.…`. */
  token?: string;
  /** Names this device on stations (default: the host name). */
  deviceName?: string;
  /** Lifetime of minted tokens, 1..30 days (default 30). */
  tokenTtlDays?: number;
  /** Connecting to a station, TLS included (default 3000 ms). */
  connectTimeoutMs?: number;
  /** One station request (default 15000 ms). */
  requestTimeoutMs?: number;
  /** The cloud attempt in cloud_first, minting and refreshes (default 10000 ms). */
  cloudTimeoutMs?: number;
  /** How long an mDNS browse listens (default 1500 ms). */
  discoverTimeoutMs?: number;
  /** Ask the station to answer once the job printed or failed, 0..30 s (default 0). */
  waitSeconds?: number;
  /** Extra CA certificates for public-hostname stations (default: Node's roots). */
  ca?: ConnectionOptions["ca"];
}

/** A station found by `local.discover()`. */
export interface LocalStation {
  stationId: string;
  name: string;
  orgId: string;
  locationId: string;
  port: number;
  addresses: string[];
  /** URLs the SDK would use, in order. */
  urls: string[];
  tlsMode: string;
  fingerprint: string;
  /** In the cloud endpoint list (authenticated). */
  fromCloud: boolean;
  /** Answered over mDNS. */
  fromMdns: boolean;
  localEnabled: boolean;
  connected: boolean;
}

const DAY = 86_400_000;

/** What a probe by idempotency key found. */
type ProbeResult = { found?: LocalJob; notFound?: boolean; conflict?: CatzPrintError };
const TOKEN_REFRESH_BEFORE = 7 * DAY;
const ENDPOINTS_MAX_AGE = 3_600_000;
const MDNS_CACHE_TTL = 60_000;
const REFRESH_RETRY_AFTER = 300_000;

const REMINT_INTERVAL = 600_000;

/** Is `h` an address a station may use on the LAN (RFC 1918, ULA, link-local, loopback)? */
export function privateIp(h: string): boolean {
  const host = h.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (isIP(host) === 6) return host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  return false;
}

/**
 * Targets for one cloud endpoint. Hostnames come only from here: verified with
 * the system roots, the public key pinned, dialled directly only under the
 * station's own label. IP URLs must be private and are pinned to the
 * self-signed certificate.
 */
export function endpointTargets(ep: LocalEndpoint, source: "config" | "cloud"): StationTarget[] {
  const fp = normalizeFingerprint(ep.cert_fingerprint_sha256);
  const spki = normalizeFingerprint(ep.public_spki_sha256);
  const out: StationTarget[] = [];
  for (const raw of ep.urls ?? []) {
    let u: string;
    try {
      u = normalizeStationUrl(raw);
    } catch {
      continue;
    }
    const host = new URL(u).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const t: StationTarget = { url: u, fingerprint: "", tlsMode: ep.tls_mode, stationId: ep.station_id, source };
    if (isIP(host)) {
      if (!privateIp(host)) continue;
      t.fingerprint = fp;
    } else {
      t.spki = spki || undefined;
      t.label = (ep.local_label || host.split(".")[1] || "").toLowerCase() || undefined;
    }
    out.push(t);
  }
  return out;
}

interface Deps {
  apiKey: string;
  baseUrl: string;
  userAgent: string;
  orgId: () => Promise<string>;
  cachedOrgId: () => string | undefined;
  localTokens: LocalTokens;
  localEndpoints: LocalEndpoints;
}

interface Claims {
  org?: string;
  live?: boolean;
}

function claims(tok: string | undefined): Claims {
  const parts = (tok ?? "").split(".");
  if (parts.length !== 3 || parts[0] !== "czl1") return {};
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Claims;
  } catch {
    return {};
  }
}

function pinKey(k: string): string {
  const s = k.trim().toLowerCase();
  if (s.includes("://")) {
    try {
      return new URL(s).host;
    } catch {
      return s;
    }
  }
  return s.replace(/\/$/, "");
}

const isCloudUnreachable = (err: unknown) => err instanceof ConnectionError || err instanceof ServerError;

const INSPECT = Symbol.for("nodejs.util.inspect.custom");
function unsupportedReason(p: CreateJobParams): string | undefined {
  if (p.sealed) return "sealed jobs go through the cloud";
  if (p.scheduledFor !== undefined) return "scheduled jobs go through the cloud";
  const local = ["commands", "template", "text", "escpos", "test"];
  if (p.kind !== undefined && !local.includes(p.kind)) return "PDFs, images and documents go through the cloud";
  if (p.content !== undefined && p.kind === undefined) return "PDFs, images and documents go through the cloud";
  return undefined;
}

/** Local printing through CatzPrint stations on the same network. Use it via `cz.local`. */
export class LocalPrinting {
  readonly mode: LocalMode;
  readonly #o: Required<Pick<LocalOptions, "connectTimeoutMs" | "requestTimeoutMs" | "cloudTimeoutMs" | "discoverTimeoutMs" | "waitSeconds" | "tokenTtlDays">> &
    LocalOptions;
  readonly #deps: Deps;
  readonly #stations: string[];
  readonly #pins = new Map<string, string>();
  readonly #store: TokenStore;
  readonly #storeKey: string;
  readonly #deviceName: string;
  readonly #transport: StationTransport;
  #state: StoredToken | undefined;
  #loaded: Promise<void> | undefined;
  #minting: Promise<StoredToken> | undefined;
  #mdns: MdnsStation[] = [];
  #mdnsAt = 0;
  #refreshing: Promise<void> | undefined;
  #nextTry = 0;
  #closed = new AbortController();
  readonly #jobUrls = new Map<string, string>();
  /** Last error from the token store (printing never stops for it). */
  storeError: unknown;
  /** @internal test hooks */
  now: () => number = () => Date.now();
  /** @internal */
  mdnsTarget: BrowseTarget = { address: MDNS_GROUP, port: MDNS_PORT };

  constructor(deps: Deps, options: LocalOptions = {}) {
    const mode = options.mode ?? "cloud";
    if (!["cloud", "local", "local_first", "cloud_first"].includes(mode)) {
      throw new TypeError(`Unknown local mode ${JSON.stringify(mode)} (use cloud, local, local_first or cloud_first).`);
    }
    this.mode = mode;
    this.#deps = deps;
    this.#stations = [...new Set((options.stations ?? []).map(normalizeStationUrl))];
    for (const [k, v] of Object.entries(options.fingerprints ?? {})) {
      const fp = normalizeFingerprint(v);
      if (!fp) throw new TypeError(`The fingerprint for ${JSON.stringify(k)} must be 64 hex characters (SHA-256).`);
      this.#pins.set(pinKey(k), fp);
    }
    if (mode !== "cloud" && this.#stations.length === 0 && !options.discover) {
      throw new TypeError("Local printing needs `stations` or `discover: true`.");
    }
    if (mode !== "cloud" && !options.token && !options.locationId && !options.allLocations) {
      throw new TypeError("Set local.locationId (minted local tokens are bound to it), or allLocations: true for a token valid at every location.");
    }
    if (options.token !== undefined && !/^(czl1\.|czd_)/.test(options.token)) {
      throw new TypeError("local.token must be a local token (czl1.…) or a device token (czd_…).");
    }
    const ttl = options.tokenTtlDays ?? 30;
    if (!(Number.isInteger(ttl) && ttl >= 1 && ttl <= 30)) throw new TypeError("tokenTtlDays must be between 1 and 30.");
    const wait = options.waitSeconds ?? 0;
    if (!(wait >= 0 && wait <= 30)) throw new TypeError("waitSeconds must be between 0 and 30.");
    this.#o = {
      ...options,
      connectTimeoutMs: options.connectTimeoutMs ?? 3_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
      cloudTimeoutMs: options.cloudTimeoutMs ?? 10_000,
      discoverTimeoutMs: options.discoverTimeoutMs ?? 1_500,
      waitSeconds: wait,
      tokenTtlDays: ttl,
    };
    this.#store = options.tokenStore ?? new MemoryTokenStore();
    let dev = options.deviceName;
    if (!dev) {
      try {
        dev = hostname() || "CatzPrint Node SDK";
      } catch {
        dev = "CatzPrint Node SDK";
      }
    }
    this.#deviceName = [...dev].slice(0, 80).join("");
    const kh = createHash("sha256").update(deps.apiKey).digest("hex").slice(0, 16);
    this.#storeKey = `v1|${kh}|${options.locationId ?? ""}|${this.#deviceName}`;
    this.#transport = new StationTransport({ connectTimeoutMs: this.#o.connectTimeoutMs, ca: options.ca, userAgent: deps.userAgent });
  }

  /** The device name sent when minting and pairing. */
  get deviceName(): string {
    return this.#deviceName;
  }

  /** Never includes tokens. */
  toJSON(): Record<string, unknown> {
    return { mode: this.mode, locationId: this.#o.locationId, stations: this.#stations, discover: !!this.#o.discover, deviceName: this.#deviceName };
  }

  [INSPECT](): string {
    return `LocalPrinting(${JSON.stringify(this.toJSON())})`;
  }

  // ---- token and endpoint state ----

  async #ensureLoaded(): Promise<void> {
    this.#loaded ??= (async () => {
      try {
        this.#state = await this.#store.load(this.#storeKey);
      } catch (err) {
        this.storeError = err;
      }
      if (this.#state?.token && isRedactedToken(this.#state.token)) {
        // A store that saved a redacted form: treat as "no token" (mint again).
        this.storeError = new Error("The token store returned a redacted token placeholder instead of a token.");
        this.#state = { ...this.#state, token: undefined, token_id: undefined };
      }
    })();
    return this.#loaded;
  }

  async #save(st: StoredToken): Promise<boolean> {
    this.#state = st;
    try {
      await this.#store.save(this.#storeKey, st);
      return true;
    } catch (err) {
      this.storeError = err;
      return false;
    }
  }

  #usable(st: StoredToken | undefined): st is StoredToken & { token: string } {
    return !!st?.token && !!st.expires_at && Date.parse(st.expires_at) > this.now() + 60_000;
  }

  #cloud(signal?: AbortSignal): CallOverrides {
    return { timeoutMs: this.#o.cloudTimeoutMs, maxRetries: 0, signal };
  }

  /** Mints a token (single-flight) and stores it with the endpoint list it brings. */
  async #mint(force: boolean, signal?: AbortSignal): Promise<StoredToken> {
    if (!force && this.#usable(this.#state)) return this.#state;
    if (this.#minting) return this.#minting;
    this.#minting = (async () => {
      const lt = await this.#deps.localTokens.create(
        { deviceName: this.#deviceName, locationIds: this.#o.locationId ? [this.#o.locationId] : undefined, ttlDays: this.#o.tokenTtlDays },
        this.#cloud(signal),
      );
      if (!lt?.token) throw new CatzPrintError({ status: 201, code: "invalid_response", message: "The API answered without a token." });
      const st: StoredToken = { ...this.#state, token: lt.token, token_id: lt.token_id, expires_at: lt.expires_at, issued_at: new Date(this.now()).toISOString() };
      if (Array.isArray(lt.stations)) {
        st.stations = lt.stations;
        st.stations_updated_at = new Date(this.now()).toISOString();
      }
      if ((await this.#save(st)) && !(this.storeError instanceof InsecureTokenStoreError)) {
        // A fresh token was stored: an earlier load problem (e.g. a stored
        // placeholder) is resolved. An insecure store is never cleared.
        this.storeError = undefined;
      }
      return st;
    })();
    try {
      return await this.#minting;
    } finally {
      this.#minting = undefined;
    }
  }

  /** The token for station requests (minting one when none is usable). */
  async token(signal?: AbortSignal): Promise<string> {
    if (this.#o.token) {
      this.#kickRefresh();
      return this.#o.token;
    }
    await this.#ensureLoaded();
    if (this.storeError instanceof InsecureTokenStoreError) throw this.storeError;
    if (this.#usable(this.#state)) {
      this.#kickRefresh();
      return this.#state.token;
    }
    const minted = (await this.#mint(false, signal)).token!;
    if (this.storeError instanceof InsecureTokenStoreError) throw this.storeError;
    return minted;
  }

  #stale(): { tok: boolean; eps: boolean } {
    const st = this.#state;
    const now = this.now();
    const tok = !this.#o.token && (!st?.token || !st.expires_at || Date.parse(st.expires_at) - now < this.refreshBefore(st));
    const eps = !st?.stations_updated_at || now - Date.parse(st.stations_updated_at) > ENDPOINTS_MAX_AGE;
    return { tok, eps };
  }

  /** @internal min(7 days, TTL/2): a short-lived token isn't renewed on every job. */
  refreshBefore(st: StoredToken | undefined): number {
    let ttl = this.#o.tokenTtlDays * DAY;
    if (st?.issued_at && st.expires_at) {
      const d = Date.parse(st.expires_at) - Date.parse(st.issued_at);
      if (d > 0) ttl = d;
    }
    return Math.min(TOKEN_REFRESH_BEFORE, ttl / 2);
  }

  #kickRefresh(): void {
    if (!this.#deps.apiKey) return; // paired-device mode: no cloud
    const { tok, eps } = this.#stale();
    if ((!tok && !eps) || this.#refreshing || this.#closed.signal.aborted || this.now() < this.#nextTry) return;
    this.#refreshing = this.#refresh(false, this.#closed.signal)
      .catch(() => {
        this.#nextTry = this.now() + REFRESH_RETRY_AFTER;
      })
      .finally(() => {
        this.#refreshing = undefined;
      });
  }

  async #refresh(force: boolean, signal?: AbortSignal): Promise<void> {
    await this.#ensureLoaded();
    const { tok, eps } = this.#stale();
    if (tok) {
      const before = this.#state?.stations_updated_at;
      const st = await this.#mint(true, signal);
      if (st.stations_updated_at !== before) return; // the mint brought the endpoint list
    }
    if (!eps && !force) return;
    const list = await this.#deps.localEndpoints.list({ locationId: this.#o.locationId }, this.#cloud(signal));
    await this.#save({ ...this.#state, stations: list, stations_updated_at: new Date(this.now()).toISOString() });
  }

  /** Waits for a background refresh started earlier (tests, graceful shutdown). */
  async idle(): Promise<void> {
    await this.#refreshing;
  }

  /**
   * Renews the token (when it has less than 7 days left) and re-reads the cloud
   * endpoint list now. The SDK also does this in the background while online.
   */
  async refresh(): Promise<void> {
    await this.#refresh(true);
  }

  /** Stops background refreshes and closes station connections. */
  async close(): Promise<void> {
    this.#closed.abort();
    await this.#refreshing;
    this.#transport.close();
  }

  #orgHint(): string | undefined {
    return this.#deps.cachedOrgId() ?? claims(this.#o.token ?? this.#state?.token).org;
  }

  /**
   * Answers a 401 with a fresh token, but only for `token_expired` (never
   * `device_revoked`: a device revoked at the station stays revoked), only for
   * minted tokens, and at most once per 10 minutes per store key (persisted).
   */
  async #remint(rejected: CatzPrintError, signal?: AbortSignal): Promise<string | undefined> {
    if (this.#o.token || !this.#deps.apiKey || rejected.code !== "token_expired") return undefined;
    const now = this.now();
    const last = this.#state?.last_remint_at ? Date.parse(this.#state.last_remint_at) : 0;
    if (last && now - last < REMINT_INTERVAL) return undefined;
    await this.#save({ ...this.#state, last_remint_at: new Date(now).toISOString() });
    return (await this.#mint(true, signal)).token;
  }

  // ---- candidates ----

  #userPinned(fp: string): boolean {
    return !!fp && [...this.#pins.values()].includes(fp);
  }

  #targetFor(url: string, mdns: MdnsStation[]): StationTarget {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const t: StationTarget = { url, fingerprint: "", tlsMode: "", stationId: "", source: "config" };
    const pin = this.#pins.get(u.host.toLowerCase()) ?? this.#pins.get(host);
    if (pin) return { ...t, fingerprint: pin };
    for (const ep of this.#state?.stations ?? []) {
      const hit = endpointTargets(ep, "config").find((x) => x.url === url);
      if (hit) return hit;
      if (isIP(host) && privateIp(host) && (ep.addresses ?? []).includes(host) && String(ep.port) === u.port) {
        return { ...t, fingerprint: normalizeFingerprint(ep.cert_fingerprint_sha256), tlsMode: ep.tls_mode, stationId: ep.station_id };
      }
    }
    for (const d of this.#acceptedMdns(mdns)) {
      if (d.addresses.includes(host) && String(d.port) === u.port) {
        return { ...t, fingerprint: d.fingerprint, tlsMode: d.tlsMode, stationId: d.stationId };
      }
    }
    return t;
  }

  #primaryTargets(): StationTarget[] {
    const out: StationTarget[] = [];
    const seen = new Set<string>();
    for (const u of this.#stations) {
      seen.add(u);
      out.push(this.#targetFor(u, this.#mdns));
    }
    if (this.#o.discover) {
      for (const ep of this.#state?.stations ?? []) {
        if (!ep.local_enabled) continue;
        if (this.#o.locationId && ep.location_id && ep.location_id !== this.#o.locationId) continue;
        for (const t of endpointTargets(ep, "cloud")) {
          if (seen.has(t.url)) continue;
          seen.add(t.url);
          out.push(t);
        }
      }
    }
    return out;
  }

  /**
   * mDNS is unauthenticated, so it only maps a station ID to its current
   * addresses: an announcement is used for a station on the cloud endpoint list
   * (pinned with the list's fingerprint and port) or one whose announced
   * fingerprint the user configured. The announced hostname is never used and
   * only private addresses are kept.
   */
  #acceptedMdns(found: MdnsStation[]): MdnsStation[] {
    const org = this.#orgHint();
    const out: MdnsStation[] = [];
    for (const raw of found) {
      if (org && raw.orgId && raw.orgId !== org) continue;
      if (this.#o.locationId && raw.locationId && raw.locationId !== this.#o.locationId) continue;
      const d: MdnsStation = { ...raw, hostname: "", addresses: raw.addresses.filter(privateIp) };
      const ep = (this.#state?.stations ?? []).find((s) => s.station_id === d.stationId);
      if (ep) {
        if (!ep.local_enabled) continue;
        d.fingerprint = normalizeFingerprint(ep.cert_fingerprint_sha256);
        d.tlsMode = "self_signed";
        if (ep.port > 0) d.port = ep.port;
      } else if (!this.#userPinned(d.fingerprint)) {
        continue;
      }
      if (!d.fingerprint || d.addresses.length === 0) continue;
      out.push(d);
    }
    return out;
  }

  static #mdnsTargets(d: MdnsStation): StationTarget[] {
    return d.addresses.map((a) => ({
      url: `https://${isIP(a) === 6 ? `[${a}]` : a}:${d.port}`,
      fingerprint: d.fingerprint,
      tlsMode: "self_signed",
      stationId: d.stationId,
      source: "mdns" as const,
    }));
  }

  async #browse(fresh: boolean, signal?: AbortSignal): Promise<MdnsStation[]> {
    if (!fresh && this.#mdnsAt && this.now() - this.#mdnsAt < MDNS_CACHE_TTL) return this.#mdns;
    const found = await mdnsBrowse(this.#o.discoverTimeoutMs, this.mdnsTarget, signal);
    this.#mdns = found;
    this.#mdnsAt = this.now();
    return found;
  }

  /** Yields candidates: configured, cloud list, then (discover, only if needed) mDNS. */
  async *#targets(preferred?: string, signal?: AbortSignal): AsyncGenerator<StationTarget> {
    const tried = new Set<string>();
    let primary = this.#primaryTargets();
    if (preferred) {
      const i = primary.findIndex((t) => t.url === preferred);
      if (i > 0) primary = [primary[i]!, ...primary.slice(0, i), ...primary.slice(i + 1)];
    }
    for (const t of primary) {
      tried.add(t.url);
      yield t;
    }
    if (!this.#o.discover) return;
    const found = await this.#browse(false, signal);
    signal?.throwIfAborted();
    for (const d of this.#acceptedMdns(found)) {
      for (const t of LocalPrinting.#mdnsTargets(d)) {
        if (tried.has(t.url)) continue;
        tried.add(t.url);
        yield t;
      }
    }
  }

  /**
   * Runs `fn` on each candidate until one answers. 401 → mint once and retry
   * that station. Returns the data, or throws the station's answer /
   * StationUnreachableError. `onRejected401` decides what a still-refused
   * token becomes.
   */
  async #authed<T>(
    fn: (t: StationTarget, token: string) => Promise<StationResult<T>>,
    opts: { preferred?: string; signal?: AbortSignal; rejected401?: "throw" | "unreachable"; notFoundMoves?: boolean; probeKey?: string },
  ): Promise<{ data: T; target: StationTarget; token: string }> {
    let token: string;
    try {
      token = await this.token(opts.signal);
    } catch (err) {
      opts.signal?.throwIfAborted();
      if (!isCloudUnreachable(err)) throw err;
      throw new StationUnreachableError([{ url: "", error: new Error(`No local token (the cloud couldn't mint one): ${(err as Error).message}`) }]);
    }
    const sue = new StationUnreachableError();
    let reminted = false;
    let notFound: unknown;
    for await (const t of this.#targets(opts.preferred, opts.signal)) {
      let r = await fn(t, token);
      // 401 token_expired: re-mint and re-send first, so the re-sent request's
      // answer goes through the same handling below (SDK9-1).
      if (r.error instanceof AuthenticationError && !reminted) {
        reminted = true;
        try {
          const fresh = await this.#remint(r.error, opts.signal);
          if (fresh) {
            token = fresh;
            r = await fn(t, token);
          }
        } catch {
          opts.signal?.throwIfAborted();
        }
      }
      let postInProgress = false;
      if (r.outcome === "answered" && opts.probeKey !== undefined && r.error instanceof CatzPrintError && r.error.status === 409 && r.error.code === "in_progress") {
        // The station is still processing a job with this key: wait for it by probing (Q1).
        r = { ...r, outcome: "no_answer", unreachable: true };
        postInProgress = true;
      }
      if (r.outcome === "ok" && opts.probeKey !== undefined && !(r.data as { id?: unknown } | undefined)?.id) {
        // A 2xx we can't use: the station may have the job; find out (C5).
        r = { outcome: "no_answer", unreachable: true, error: new CatzPrintError({ status: 201, code: "invalid_response", message: "The station answered without a job." }) };
      }
      if (opts.signal?.aborted) {
        // Cancelled after the job was sent: it may print (C6).
        if (r.outcome === "no_answer" && opts.probeKey !== undefined) throw new OutcomeUnknownError(t.url, opts.probeKey, opts.signal.reason);
        throw opts.signal.reason;
      }
      if (r.outcome === "no_answer" && opts.probeKey !== undefined) {
        // The station got the job but its answer was lost: ask it by key.
        // Never send it anywhere else while that is unknown.
        let pr: ProbeResult;
        try {
          pr = await this.#probe(t, token, opts.probeKey, opts.signal);
        } catch (err) {
          if (opts.signal?.aborted) throw new OutcomeUnknownError(t.url, opts.probeKey, opts.signal.reason);
          throw err;
        }
        if (pr.found) return { data: pr.found as T, target: t, token };
        if (pr.conflict) throw pr.conflict; // 409 duplicate: an answer, no fallback
        // After a POST answered in_progress, a 404 doesn't mean "never recorded" (S4).
        if (!pr.notFound || postInProgress) throw new OutcomeUnknownError(t.url, opts.probeKey, r.error);
        sue.attempts.push({ url: t.url, error: r.error });
        continue;
      }
      if (r.outcome === "no_answer" && r.error instanceof CatzPrintError && r.error.code === "response_too_large") throw r.error;
      if (!r.error) return { data: r.data as T, target: t, token };
      if (r.unreachable) {
        sue.attempts.push({ url: t.url, error: r.error });
        continue;
      }
      if (r.error instanceof AuthenticationError && opts.rejected401 === "unreachable") {
        sue.attempts.push({ url: t.url, error: r.error });
        throw sue;
      }
      if (opts.notFoundMoves && r.error instanceof CatzPrintError && r.error.status === 404) {
        notFound = r.error;
        continue;
      }
      throw r.error;
    }
    opts.signal?.throwIfAborted();
    if (notFound) throw notFound;
    throw sue;
  }

  /**
   * Asks the station that may have a job for it by idempotency key: up to 3
   * tries within 5 s, each on a new connection with the same pinning.
   */
  /**
   * Probe answers: 200 → that job; 404 `not_found` → never recorded (unless
   * an earlier probe answered in_progress: then unknown); 409
   * `duplicate` → the key belongs to a job this caller can't see (an answer);
   * anything else → keep probing.
   */
  async #probe(t: StationTarget, token: string, key: string, signal?: AbortSignal): Promise<ProbeResult> {
    const deadline = Date.now() + 5_000;
    let sawInProgress = false;
    for (let i = 0; i < 3; i++) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const r = await this.#transport.request<LocalJob>(t, "GET", `/local/v1/jobs?idempotency_key=${encodeURIComponent(key)}`, {
        token,
        timeoutMs: Math.min(left, this.#o.requestTimeoutMs),
        signal,
      });
      if (r.outcome === "ok" && (r.data as { id?: unknown } | undefined)?.id) return { found: r.data };
      if (r.outcome === "answered" && r.error instanceof CatzPrintError) {
        // After an in_progress answer, a 404 isn't "never recorded" (T2): unknown.
        if (r.error.status === 404 && r.error.code === "not_found") return sawInProgress ? {} : { notFound: true };
        if (r.error.status === 409 && r.error.code === "duplicate") return { conflict: r.error };
        if (r.error.status === 409 && r.error.code === "in_progress") sawInProgress = true;
      }
      if (i < 2) await sleep(Math.max(0, Math.min(5_000 / 6, deadline - Date.now())), signal);
    }
    return {};
  }

  /**
   * The cloud leg of the fallback modes:
   * - an ambiguous answer (sent without answer, any 5xx but 502/503/504, a
   *   redirect, an unreadable body) gets one retry with the same key;
   * - a 409 "duplicate"/"being created" gets up to 3 identical re-sends, 1 s apart;
   * - still ambiguous, or a re-send not delivered → OutcomeUnknownError (the
   *   cloud may have the job: never a station);
   * - cancelled after the request was written → OutcomeUnknownError wrapping it.
   */
  async #cloudCareful(p: CreateJobParams, jobs: Jobs, timeoutMs?: number): Promise<Job> {
    // Built (and sealed) once: the retry and the re-sends send the same bytes.
    const prepared = await jobs.prepareCloud(p);
    const post = (prep: PreparedCreate) => jobs.postCloud(prep, { once: true, timeoutMs });
    const once = () => post(prepared);
    const unknown = (e: unknown) => new OutcomeUnknownError(this.#deps.baseUrl, p.idempotencyKey ?? "", e);
    let err: unknown;
    try {
      return await once();
    } catch (e) {
      err = e;
    }
    if (p.signal?.aborted) throw sentAndLost(err) ? unknown(p.signal.reason) : p.signal.reason;
    if (cloudAmbiguous(err)) {
      try {
        return await once();
      } catch (e) {
        err = e;
      }
      if (p.signal?.aborted) throw unknown(p.signal.reason); // the first attempt was already ambiguous
      if (p.sealed && sealedRejected(err)) return jobs.resealAndResend(p, err, true, post, unknown);
      if (!isConflictInProgress(err)) {
        if (cloudAmbiguous(err) || cloudNotDelivered(err)) throw unknown(err);
        throw err;
      }
    }
    // The API couldn't decrypt the sealed content (key rotated): seal again, once (S1).
    if (p.sealed && sealedRejected(err)) return jobs.resealAndResend(p, err, false, post, unknown);
    if (isConflictInProgress(err)) return resendWhileInProgress(once, err, unknown, p.signal);
    throw err;
  }

  // ---- jobs ----

  /** @internal Routes `jobs.create` by mode. */
  async create(params: CreateJobParams, jobs: Jobs): Promise<Job> {
    if (this.mode === "cloud") return jobs.createCloud(params);
    // The same key goes to the station and the cloud, so a fallback never prints twice.
    const p: CreateJobParams = { ...params, idempotencyKey: params.idempotencyKey ?? `sdk-${randomUUID()}` };
    if (p.printerId === undefined && p.locationId === undefined && this.#o.locationId) p.locationId = this.#o.locationId;
    const why = unsupportedReason(p);
    if (this.mode === "local") {
      if (why) throw unsupportedLocally(why);
      return this.#createLocal(p, jobs);
    }
    if (why) return jobs.createCloudMode(p); // can't print locally: the cloud-mode create
    if (this.mode === "local_first") {
      try {
        return await this.#createLocal(p, jobs);
      } catch (err) {
        if (!(err instanceof StationUnreachableError) || p.signal?.aborted) throw err;
        try {
          return await this.#cloudCareful(p, jobs);
        } catch (cloudErr) {
          if (!cloudNotDelivered(cloudErr)) throw cloudErr;
          err.cloudError = cloudErr;
          throw err;
        }
      }
    }
    // cloud_first
    let cloudErr: unknown;
    try {
      return await this.#cloudCareful(p, jobs, this.#o.cloudTimeoutMs);
    } catch (err) {
      if (err instanceof OutcomeUnknownError) throw err;
      p.signal?.throwIfAborted();
      if (!cloudNotDelivered(err) || why) throw err;
      cloudErr = err;
    }
    try {
      return await this.#createLocal(p, jobs);
    } catch (err) {
      if (err instanceof StationUnreachableError) err.cloudError = cloudErr;
      throw err;
    }
  }

  async #createLocal(p: CreateJobParams, jobs: Jobs): Promise<Job> {
    const body = await jobs.buildCreateBody(p);
    delete body.file_name;
    delete body.scheduled_for;
    const wait = this.#o.waitSeconds ? `?wait=${Math.ceil(this.#o.waitSeconds)}` : "";
    const { data, target, token } = await this.#authed<LocalJob>(
      (t, tok) =>
        this.#transport.request<LocalJob>(t, "POST", `/local/v1/jobs${wait}`, {
          token: tok,
          body,
          timeoutMs: this.#o.requestTimeoutMs + this.#o.waitSeconds * 1000,
          signal: p.signal,
        }),
      { signal: p.signal, rejected401: this.mode === "local" ? "throw" : "unreachable", probeKey: String(body.idempotency_key ?? "") },
    );
    this.#remember(data.id, target.url);
    return toJob(data, target, String(body.kind ?? ""), tokenLive(token));
  }

  #remember(id: string, url: string): void {
    if (!id) return;
    if (this.#jobUrls.size >= 1000) this.#jobUrls.clear();
    this.#jobUrls.set(id, url);
  }

  // ---- public helpers ----

  /** A local job ("lj_…") from the station that has it. `jobs.get` calls this for local IDs. */
  async getJob(id: string, signal?: AbortSignal): Promise<JobWithEvents> {
    const preferred = this.#jobUrls.get(id);
    const { data, target, token } = await this.#authed<LocalJob>(
      (t, tok) => this.#transport.request<LocalJob>(t, "GET", `/local/v1/jobs/${encodeURIComponent(id)}`, { token: tok, timeoutMs: this.#o.requestTimeoutMs, signal }),
      { preferred, signal, notFoundMoves: true },
    );
    this.#remember(id, target.url);
    return { ...toJob(data, target, "", tokenLive(token)), events: [] };
  }

  /** The first reachable station's status (printers, paper, unsynced jobs, offline allowance). */
  async status(signal?: AbortSignal): Promise<LocalStatus> {
    const { data, target } = await this.#authed<LocalStatus>(
      (t, tok) => this.#transport.request<LocalStatus>(t, "GET", "/local/v1/status", { token: tok, timeoutMs: this.#o.requestTimeoutMs, signal }),
      { signal },
    );
    return { ...data, station_url: target.url };
  }

  async #explicitTarget(url: string): Promise<StationTarget> {
    const u = normalizeStationUrl(url);
    await this.#ensureLoaded();
    let t = this.#targetFor(u, this.#mdns);
    if (needsPin(t) && !t.fingerprint && this.#o.discover) {
      const found = await this.#browse(true);
      t = this.#targetFor(u, found);
    }
    return t;
  }

  /** Trust for pairing, without mDNS: the app's fingerprint or the cloud list. */
  async #pairTarget(url: string, fingerprint?: string): Promise<StationTarget> {
    const u = normalizeStationUrl(url);
    const host = new URL(u).hostname.replace(/^\[|\]$/g, "");
    if (fingerprint !== undefined) {
      const fp = normalizeFingerprint(fingerprint);
      if (!fp) throw new TypeError("The fingerprint is the 64 hex characters (SHA-256) shown in the station app.");
      if (!isIP(host)) throw new TypeError("Pair with the station's IP address URL when you pass the fingerprint from the station app.");
      return { url: u, fingerprint: fp, tlsMode: "self_signed", stationId: "", source: "config" };
    }
    await this.#ensureLoaded();
    const t = this.#targetFor(u, []);
    if ((needsPin(t) && !t.fingerprint) || (!needsPin(t) && !t.stationId)) {
      throw new TypeError("Pairing needs the certificate fingerprint shown in the station app ({ fingerprint }), or a station on the cloud endpoint list.");
    }
    return t;
  }

  /** A station's public info (`GET /local/v1/info`), trusted like any station URL. */
  async info(url: string): Promise<LocalInfo> {
    const t = await this.#explicitTarget(url);
    const r = await this.#transport.request<LocalInfo>(t, "GET", "/local/v1/info", { timeoutMs: this.#o.requestTimeoutMs });
    if (r.unreachable) throw new StationUnreachableError([{ url: t.url, error: r.error }]);
    if (r.error) throw r.error;
    return r.data!;
  }

  /**
   * Pairs this device with one station using the 8-digit code from the station
   * app. The `czd_…` token works on that station without any cloud account;
   * pass it as `local.token`. The station is authenticated before the code is
   * sent: an IP URL needs `{ fingerprint }` from the station app (or
   * `local.fingerprints`, or the cloud list); a hostname must be on the cloud
   * endpoint list. mDNS is never enough.
   */
  async pair(url: string, code: string, deviceName?: string, options: { fingerprint?: string } = {}): Promise<LocalPairing> {
    checkPairingCode(code);
    const t = await this.#pairTarget(url, options.fingerprint);
    const r = await this.#transport.request<Record<string, unknown>>(t, "POST", "/local/v1/pair", {
      body: { code, device_name: [...(deviceName || this.#deviceName)].slice(0, 80).join("") },
      timeoutMs: this.#o.requestTimeoutMs,
    });
    if (r.unreachable) throw new StationUnreachableError([{ url: t.url, error: r.error }]);
    if (r.error) throw r.error;
    return toPairing(r.data!);
  }

  /**
   * Stations from the cloud endpoint list (refreshed now when the cloud
   * answers) and an mDNS browse, merged by station ID.
   */
  async discover(): Promise<LocalStation[]> {
    await this.#ensureLoaded();
    let cloudErr: unknown;
    try {
      await this.#refresh(true);
    } catch (err) {
      cloudErr = err;
    }
    const found = await this.#browse(true);
    const out: LocalStation[] = [];
    const idx = new Map<string, number>();
    for (const ep of this.#state?.stations ?? []) {
      if (this.#o.locationId && ep.location_id && ep.location_id !== this.#o.locationId) continue;
      idx.set(ep.station_id, out.length);
      out.push(fromEndpoint(ep, this.#orgHint() ?? ""));
    }
    for (const d of this.#acceptedMdns(found)) {
      const urls = LocalPrinting.#mdnsTargets(d).map((t) => t.url);
      const i = idx.get(d.stationId);
      if (i !== undefined) {
        const s = out[i]!;
        s.fromMdns = true;
        for (const a of d.addresses) if (!s.addresses.includes(a)) s.addresses.push(a);
        for (const u of urls) if (!s.urls.includes(u)) s.urls.push(u);
        continue;
      }
      idx.set(d.stationId, out.length);
      out.push({
        stationId: d.stationId, name: d.instance, orgId: d.orgId, locationId: d.locationId, port: d.port,
        addresses: d.addresses, urls, tlsMode: d.tlsMode, fingerprint: d.fingerprint,
        fromCloud: false, fromMdns: true, localEnabled: true, connected: false,
      });
    }
    if (out.length === 0 && cloudErr) throw cloudErr;
    return out;
  }
}

function fromEndpoint(ep: LocalEndpoint, org: string): LocalStation {
  const urls = endpointTargets(ep, "cloud").map((t) => t.url);
  return {
    stationId: ep.station_id, name: ep.name, orgId: org, locationId: ep.location_id ?? "", port: ep.port,
    addresses: [...(ep.addresses ?? [])], urls, tlsMode: ep.tls_mode, fingerprint: normalizeFingerprint(ep.cert_fingerprint_sha256),
    fromCloud: true, fromMdns: false, localEnabled: ep.local_enabled, connected: ep.connected,
  };
}

function unsupportedLocally(why: string): ValidationError {
  return new ValidationError({
    status: 422,
    code: "unsupported_locally",
    message: `This job can't print locally: ${why}. Send PDFs, images and documents through the cloud.`,
  });
}

/** Paired devices (czd_) are live; local tokens carry the flag in their claims. */
function tokenLive(tok: string): boolean {
  return tok.startsWith("czd_") || !!claims(tok).live;
}

function toJob(lj: LocalJob, t: StationTarget, kind: string, live: boolean): Job {
  return {
    id: lj.id,
    live: typeof lj.live === "boolean" ? lj.live : live,
    source: "local",
    kind,
    status: lj.status,
    status_detail: lj.detail || lj.error_code || "",
    title: lj.title ?? "",
    reference: lj.reference ?? "",
    copies: lj.copies,
    printer_id: lj.printer_id || null,
    printer_name: lj.printer_name || null,
    station_id: t.stationId || null,
    station_name: null,
    location_id: lj.location_id || null,
    location_name: null,
    size: 0,
    attempts: 1,
    billed_as: "",
    created_by: null,
    reprint_of: null,
    scheduled_for: null,
    created_at: lj.created_at,
    sent_at: lj.created_at,
    printed_at: lj.status === "printed" ? lj.finished_at : null,
    finished_at: lj.finished_at,
    printed_locally: true,
    idempotency_key: lj.idempotency_key,
    via: "local",
    local: { ...lj, station_url: t.url },
  };
}
