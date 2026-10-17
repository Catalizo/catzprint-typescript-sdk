import { randomUUID } from "node:crypto";
import { ConflictError, TimeoutError } from "../errors.js";
import type { HttpClient } from "../http.js";
import {
  FINAL_JOB_STATUSES,
  type EscposCommand,
  type Job,
  type JobKind,
  type JobPage,
  type JobStatus,
  type JobWithEvents,
} from "../types.js";

/** Bytes accepted as job content. Node Buffers are Uint8Arrays. */
export type Bytes = Uint8Array | ArrayBuffer;

/** Where and how to print. Shared by `jobs.create` and the print helpers. */
export interface JobTarget {
  /** Print on this printer. */
  printerId?: string;
  /** Let routing pick a printer at this location. */
  locationId?: string;
  /** Let routing pick a printer with this role: receipt, kitchen, bar, label, office, other. */
  role?: string;
  /** Shown in the console and on the station. Up to 200 characters. */
  title?: string;
  /** Your own reference (order number…). Searchable. Up to 120 characters. */
  reference?: string;
  /** 1..50. Default 1 (or the routing rule's copies). */
  copies?: number;
  /**
   * Makes the create safe to retry: the same key returns the same job.
   * The SDK generates a UUID v4 when you don't pass one.
   */
  idempotencyKey?: string;
  /** Hold the job until this time (at most 30 days ahead). */
  scheduledFor?: Date | string;
  /** Free-form options stored with the job. */
  options?: Record<string, unknown>;
}

export interface CreateJobParams extends JobTarget {
  /** What the station prints. Inferred from the content source when omitted. */
  kind?: JobKind;
  /** Plain text to print (kind "text"). */
  text?: string;
  /** ESC/POS commands (kind "commands"). */
  commands?: EscposCommand[];
  /** A saved template to render with `data` (kind "template"). */
  templateId?: string;
  data?: Record<string, unknown>;
  /** Raw bytes: PDF, PNG/JPEG, ESC/POS, or an Office document with `fileName`. */
  content?: Bytes;
  /** File name, used by the API to detect the document type. */
  fileName?: string;
  /**
   * Encrypt the content to the server's public key before sending (NaCl
   * sealed box). Works with `text` and `content`.
   */
  sealed?: boolean;
}

export interface ListJobsParams {
  /** One status or several. */
  status?: JobStatus | JobStatus[];
  printerId?: string;
  stationId?: string;
  locationId?: string;
  source?: string;
  /** true for live jobs only, false for test jobs only. */
  live?: boolean;
  /** Search reference, title or job ID prefix. */
  q?: string;
  /** Only jobs created at or after this time. */
  since?: Date | string;
  /** Page size, 1..200 (default 50). */
  limit?: number;
  /** `next_cursor` from the previous page. */
  cursor?: string;
  /** Include per-status counts for the last 24 hours. */
  counts?: boolean;
}

export interface WaitForOptions {
  /** Give up after this many milliseconds. Default 60000. */
  timeoutMs?: number;
  /** Poll every this many milliseconds. Default 1000. */
  intervalMs?: number;
  signal?: AbortSignal;
}

export interface ReprintParams {
  /** Print on another printer instead of the original one. */
  printerId?: string;
  copies?: number;
}

/** What `Jobs` needs from the client. */
export interface JobsContext {
  http: HttpClient;
  orgId(): Promise<string>;
  seal(content: Uint8Array): Promise<string>;
  sleep(ms: number): Promise<void>;
}

export function toUint8(b: Bytes): Uint8Array {
  return b instanceof Uint8Array ? b : new Uint8Array(b);
}

function base64(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64");
}

/** Detects PDF, PNG and JPEG by their magic bytes. */
export function detectKind(b: Uint8Array): JobKind | undefined {
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return "pdf";
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image";
  return undefined;
}

function iso(v: Date | string | undefined): string | undefined {
  if (v === undefined) return undefined;
  return v instanceof Date ? v.toISOString() : v;
}

/** Print jobs: create, read, list, cancel, retry, reprint and wait. */
export class Jobs {
  readonly #ctx: JobsContext;

  constructor(ctx: JobsContext) {
    this.#ctx = ctx;
  }

  /** Builds the JSON body for `POST /v1/orgs/{org}/jobs`. Exposed for testing. */
  async buildCreateBody(params: CreateJobParams): Promise<Record<string, unknown>> {
    const sources = [
      params.text !== undefined,
      params.commands !== undefined,
      params.templateId !== undefined,
      params.content !== undefined,
    ].filter(Boolean).length;
    if (sources !== 1) {
      throw new TypeError("Pass exactly one content source: text, commands, templateId (+ data) or content.");
    }
    if (params.sealed && (params.commands !== undefined || params.templateId !== undefined)) {
      throw new TypeError("sealed works with text or content, not with commands or templates.");
    }
    const body: Record<string, unknown> = {
      printer_id: params.printerId,
      location_id: params.locationId,
      role: params.role,
      title: params.title,
      reference: params.reference,
      copies: params.copies,
      idempotency_key: params.idempotencyKey ?? randomUUID(),
      scheduled_for: iso(params.scheduledFor),
      options: params.options,
      file_name: params.fileName,
    };
    let kind = params.kind;
    if (params.text !== undefined) {
      kind ??= "text";
      if (kind !== "text") throw new TypeError(`text needs kind "text", not "${kind}".`);
      if (params.sealed) body.sealed_content = await this.#ctx.seal(new TextEncoder().encode(params.text));
      else body.content = params.text;
    } else if (params.commands !== undefined) {
      kind ??= "commands";
      body.commands = params.commands;
    } else if (params.templateId !== undefined) {
      kind ??= "template";
      body.template_id = params.templateId;
      body.data = params.data ?? {};
    } else {
      const bytes = toUint8(params.content!);
      // With a file name and no kind, the API detects the type ("document").
      if (kind === undefined && params.fileName === undefined) {
        kind = detectKind(bytes);
        if (kind === undefined) {
          throw new TypeError('Couldn\'t tell what this content is. Set kind ("pdf", "image", "escpos", "text") or fileName.');
        }
      }
      if (params.sealed) body.sealed_content = await this.#ctx.seal(bytes);
      else if (kind === "text") body.content = new TextDecoder().decode(bytes);
      else body.content = base64(bytes);
    }
    body.kind = kind;
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
    return body;
  }

  /**
   * Creates a print job. Always sends an idempotency key, so network errors
   * and 5xx/429 answers are retried without printing twice.
   */
  async create(params: CreateJobParams): Promise<Job> {
    const body = await this.buildCreateBody(params);
    const org = await this.#ctx.orgId();
    const send = () =>
      this.#ctx.http.request<{ job: Job }>({ method: "POST", path: `/v1/orgs/${org}/jobs`, body, idempotent: true });
    try {
      return (await send()).job;
    } catch (err) {
      // A retried create can race the original, still-running request.
      // The API then answers 409 "duplicate"; ask again to get that job.
      if (err instanceof ConflictError && err.code === "duplicate") {
        await this.#ctx.sleep(1000);
        return (await send()).job;
      }
      throw err;
    }
  }

  /** Gets a job and its history. */
  async get(id: string): Promise<JobWithEvents> {
    const org = await this.#ctx.orgId();
    const res = await this.#ctx.http.request<{ job: Job; events: JobWithEvents["events"] }>({
      method: "GET",
      path: `/v1/orgs/${org}/jobs/${encodeURIComponent(id)}`,
    });
    return { ...res.job, events: res.events ?? [] };
  }

  /** Lists jobs, newest first, one page at a time. */
  async list(params: ListJobsParams = {}): Promise<JobPage> {
    const org = await this.#ctx.orgId();
    const res = await this.#ctx.http.request<{ items: Job[]; next_cursor?: string; counts?: Record<string, number> }>({
      method: "GET",
      path: `/v1/orgs/${org}/jobs`,
      query: {
        status: Array.isArray(params.status) ? params.status.join(",") : params.status,
        printer_id: params.printerId,
        station_id: params.stationId,
        location_id: params.locationId,
        source: params.source,
        live: params.live,
        q: params.q,
        since: iso(params.since),
        limit: params.limit,
        cursor: params.cursor,
        counts: params.counts ? true : undefined,
      },
    });
    return { items: res.items ?? [], next_cursor: res.next_cursor || undefined, counts: res.counts ?? {} };
  }

  /**
   * Iterates over every matching job, fetching pages as needed:
   * `for await (const job of client.jobs.iterate({ status: "failed" })) …`
   */
  async *iterate(params: ListJobsParams = {}): AsyncGenerator<Job, void, undefined> {
    let cursor = params.cursor;
    for (;;) {
      const page = await this.list({ ...params, cursor });
      yield* page.items;
      if (!page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }

  /** Cancels a scheduled, held, queued or sent job. */
  async cancel(id: string): Promise<Job> {
    return this.#action(id, "cancel");
  }

  /** Queues a failed or held job again. */
  async retry(id: string): Promise<Job> {
    return this.#action(id, "retry");
  }

  /** Prints a job again as a new job, optionally on another printer. */
  async reprint(id: string, params: ReprintParams = {}): Promise<Job> {
    return this.#action(id, "reprint", { printer_id: params.printerId, copies: params.copies });
  }

  async #action(id: string, action: string, body: Record<string, unknown> = {}): Promise<Job> {
    const org = await this.#ctx.orgId();
    const res = await this.#ctx.http.request<{ job: Job }>({
      method: "POST",
      path: `/v1/orgs/${org}/jobs/${encodeURIComponent(id)}/${action}`,
      body,
      idempotent: false,
    });
    return res.job;
  }

  /**
   * Polls a job until it is printed, failed or cancelled and returns it.
   * Throws TimeoutError when it takes longer than `timeoutMs`.
   */
  async waitFor(id: string, options: WaitForOptions = {}): Promise<JobWithEvents> {
    const timeoutMs = options.timeoutMs !== undefined && !Number.isNaN(options.timeoutMs) ? options.timeoutMs : 60_000;
    // Never poll in a tight loop: a zero, negative or NaN interval uses the default.
    const intervalMs = options.intervalMs !== undefined && options.intervalMs > 0 ? options.intervalMs : 1_000;
    const deadline = Date.now() + timeoutMs;
    let last: JobWithEvents | undefined;
    for (;;) {
      options.signal?.throwIfAborted();
      last = await this.get(id);
      if (FINAL_JOB_STATUSES.includes(last.status)) return last;
      const left = deadline - Date.now();
      if (left <= 0) throw new TimeoutError(id, timeoutMs, last);
      await this.#ctx.sleep(Math.min(intervalMs, left));
    }
  }
}
