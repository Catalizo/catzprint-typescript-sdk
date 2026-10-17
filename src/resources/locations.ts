import type { HttpClient } from "../http.js";
import type { Location } from "../types.js";

/** Locations in your organization (read-only for API keys). */
export class Locations {
  readonly #http: HttpClient;
  readonly #orgId: () => Promise<string>;

  constructor(http: HttpClient, orgId: () => Promise<string>) {
    this.#http = http;
    this.#orgId = orgId;
  }

  /** Lists locations. Needs the `locations:read` scope. */
  async list(): Promise<Location[]> {
    const org = await this.#orgId();
    const res = await this.#http.request<{ locations: Location[] }>({ method: "GET", path: `/v1/orgs/${org}/locations` });
    return res.locations ?? [];
  }

  /** Gets one location. */
  async get(id: string): Promise<Location> {
    const org = await this.#orgId();
    const res = await this.#http.request<{ location: Location }>({
      method: "GET",
      path: `/v1/orgs/${org}/locations/${encodeURIComponent(id)}`,
    });
    return res.location;
  }
}
