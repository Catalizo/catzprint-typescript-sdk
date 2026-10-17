import type { HttpClient } from "../http.js";
import type { Printer } from "../types.js";

export interface ListPrintersParams {
  /** Only printers on this station. */
  stationId?: string;
}

/** Printers in your organization (read-only for API keys). */
export class Printers {
  readonly #http: HttpClient;
  readonly #orgId: () => Promise<string>;

  constructor(http: HttpClient, orgId: () => Promise<string>) {
    this.#http = http;
    this.#orgId = orgId;
  }

  /** Lists printers, with their live status. Needs the `printers:read` scope. */
  async list(params: ListPrintersParams = {}): Promise<Printer[]> {
    const org = await this.#orgId();
    const res = await this.#http.request<{ printers: Printer[] }>({
      method: "GET",
      path: `/v1/orgs/${org}/printers`,
      query: { station_id: params.stationId },
    });
    return res.printers ?? [];
  }
}
