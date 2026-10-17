import type { HttpClient } from "../http.js";
import type { Template } from "../types.js";

/** Saved receipt templates. Print one with `client.printTemplate(id, data)`. */
export class Templates {
  readonly #http: HttpClient;
  readonly #orgId: () => Promise<string>;

  constructor(http: HttpClient, orgId: () => Promise<string>) {
    this.#http = http;
    this.#orgId = orgId;
  }

  /** Lists templates. Needs the `jobs:write` scope. */
  async list(): Promise<Template[]> {
    const org = await this.#orgId();
    const res = await this.#http.request<{ templates: Template[] }>({ method: "GET", path: `/v1/orgs/${org}/templates` });
    return res.templates ?? [];
  }
}
