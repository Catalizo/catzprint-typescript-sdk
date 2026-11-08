import type { HttpClient } from "../http.js";
import { hideToken } from "../local/shared.js";
import type { LocalEndpoint, LocalToken } from "../local/types.js";

export interface CreateLocalTokenParams {
  /** Names the device on stations (up to 80 characters). */
  deviceName: string;
  /** Narrow the token to these locations (default: every location the key may use). */
  locationIds?: string[];
  /** 1..30 (default 30). */
  ttlDays?: number;
}

/** Per-call overrides used by the local-printing code. */
export interface CallOverrides {
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
}

/** Local tokens (`czl1…`): let a device print through stations without the internet. */
export class LocalTokens {
  readonly #http: HttpClient;
  readonly #orgId: () => Promise<string>;

  constructor(http: HttpClient, orgId: () => Promise<string>) {
    this.#http = http;
    this.#orgId = orgId;
  }

  /** Mints a local token (`POST /v1/orgs/{org}/local-tokens`). Needs the `jobs:write` scope. */
  async create(params: CreateLocalTokenParams, overrides: CallOverrides = {}): Promise<LocalToken> {
    if (!params?.deviceName) throw new TypeError("deviceName is required.");
    if (params.ttlDays !== undefined && !(Number.isInteger(params.ttlDays) && params.ttlDays >= 1 && params.ttlDays <= 30)) {
      throw new TypeError("ttlDays must be an integer between 1 and 30.");
    }
    const org = await this.#orgId();
    const res = await this.#http.request<LocalToken>({
      method: "POST",
      path: `/v1/orgs/${org}/local-tokens`,
      body: { device_name: params.deviceName, location_ids: params.locationIds, ttl_days: params.ttlDays },
      idempotent: false,
      ...overrides,
    });
    // `token` stays readable as lt.token but out of console.log / JSON.stringify.
    return hideToken({ ...res, stations: res.stations ?? [] });
  }

  /** Revokes a local token by its token ID (jti). */
  async revoke(tokenId: string): Promise<void> {
    const org = await this.#orgId();
    await this.#http.request<void>({ method: "DELETE", path: `/v1/orgs/${org}/local-tokens/${encodeURIComponent(tokenId)}` });
  }
}

/** The stations' local-network addresses as the cloud knows them. */
export class LocalEndpoints {
  readonly #http: HttpClient;
  readonly #orgId: () => Promise<string>;

  constructor(http: HttpClient, orgId: () => Promise<string>) {
    this.#http = http;
    this.#orgId = orgId;
  }

  /** Lists stations' local endpoints, optionally only at one location. */
  async list(params: { locationId?: string } = {}, overrides: CallOverrides = {}): Promise<LocalEndpoint[]> {
    const org = await this.#orgId();
    const res = await this.#http.request<{ stations: LocalEndpoint[] | null }>({
      method: "GET",
      path: `/v1/orgs/${org}/local-endpoints`,
      query: { location_id: params.locationId },
      ...overrides,
    });
    return res.stations ?? [];
  }
}
