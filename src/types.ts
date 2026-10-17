/** Job lifecycle states. */
export type JobStatus = "scheduled" | "held" | "queued" | "sent" | "printing" | "printed" | "failed" | "cancelled";

/** Final states: `jobs.waitFor` returns once a job reaches one. */
export const FINAL_JOB_STATUSES: readonly JobStatus[] = ["printed", "failed", "cancelled"];

/** What the station prints. `document` lets the API detect PDF / image / text / Office files. */
export type JobKind = "text" | "commands" | "template" | "escpos" | "image" | "pdf" | "document" | "test";

/** A print job. Timestamps are ISO 8601 strings. */
export interface Job {
  id: string;
  live: boolean;
  source: string;
  kind: string;
  status: JobStatus;
  status_detail: string;
  title: string;
  reference: string;
  copies: number;
  printer_id: string | null;
  printer_name: string | null;
  station_id: string | null;
  station_name: string | null;
  location_id: string | null;
  location_name: string | null;
  size: number;
  attempts: number;
  /** `"test"` for test-key jobs; otherwise how the print was billed. */
  billed_as: string;
  created_by: string | null;
  reprint_of: string | null;
  scheduled_for: string | null;
  created_at: string;
  sent_at: string | null;
  printed_at: string | null;
  finished_at: string | null;
}

/** One entry of a job's history. */
export interface JobEvent {
  at: string;
  status: string;
  detail: string;
  actor: string;
}

/** A job plus its history, as returned by `jobs.get`. */
export interface JobWithEvents extends Job {
  events: JobEvent[];
}

/** One page of `jobs.list`. */
export interface JobPage {
  items: Job[];
  /** Pass as `cursor` to get the next page; `""`/undefined when there are no more. */
  next_cursor: string | undefined;
  /** Counts per status for the last 24 hours, when `counts: true` was asked. */
  counts: Record<string, number>;
}

/** A printer attached to a station. */
export interface Printer {
  id: string;
  station_id: string;
  station_name: string;
  location_id: string | null;
  device_key: string;
  name: string;
  role: string;
  connection: string;
  address: string;
  paper: string;
  capabilities: string[];
  enabled: boolean;
  status: string;
  status_detail: string;
  shared_with_individuals: boolean;
  station_enabled: boolean;
  station_connected: boolean;
  updated_at: string;
}

/** A place with stations (a shop, a kitchen, an office). */
export interface Location {
  id: string;
  name: string;
  address: string;
  time_zone: string;
  enabled: boolean;
  disabled_at: string | null;
  disabled_job_policy: "hold" | "fallback" | "reject" | string;
  fallback_location_id: string | null;
  stations: number;
  printers: number;
  created_at: string;
}

/** A saved receipt template (ESC/POS command list with placeholders). */
export interface Template {
  id: string;
  name: string;
  paper: string;
  body: unknown;
  version: number;
  updated_at: string;
}

/** The API key in use (`GET /v1/key`). */
export interface ApiKeyInfo {
  id: string;
  org_id: string;
  org_name: string;
  live: boolean;
  scopes: string[];
}

/** The server's public key for sealing content. */
export interface ServerKey {
  public_key: string;
  algorithm: string;
}

/** A webhook delivery body. */
export interface WebhookEvent<T = Record<string, unknown>> {
  /**
   * Delivery id, identical across retries of the same delivery. Deduplicate on it: the
   * timestamp check only limits the replay window to the tolerance (5 minutes by default).
   * Absent when the server did not send one.
   */
  id?: string;
  type: string;
  created_at: string;
  org_id: string;
  data: T;
}

/** Payload of `job.*` webhook events. */
export type JobWebhookEvent = WebhookEvent<{ job: Job }>;

// ---- ESC/POS commands (server/internal/escpos) ----

export type Align = "left" | "center" | "right";

export interface TextCommand {
  type: "text";
  text: string;
  align?: Align;
  bold?: boolean;
  underline?: boolean;
  invert?: boolean;
  /** 1..8, width and height multiplier. */
  size?: number;
  font?: "a" | "b";
}
export interface FeedCommand {
  type: "feed";
  lines?: number;
}
export interface LineCommand {
  type: "line";
  /** Character to draw the rule with (default "-"). */
  char?: string;
}
export interface Column {
  text: string;
  /** Fraction of the line width; 0 or omitted shares what's left. */
  width?: number;
  align?: Align;
  bold?: boolean;
}
export interface ColumnsCommand {
  type: "columns";
  columns: Column[];
}
export interface BarcodeCommand {
  type: "barcode";
  data: string;
  format?: "code128" | "ean13" | "code39";
  align?: Align;
}
export interface QrCommand {
  type: "qr";
  data: string;
  align?: Align;
  size?: number;
}
export interface ImageCommand {
  type: "image";
  /** PNG or JPEG, base64. */
  data: string;
  align?: Align;
}
export interface CutCommand {
  type: "cut";
  partial?: boolean;
}
export interface DrawerCommand {
  type: "drawer";
  /** 2 (default) or 5. */
  pin?: 2 | 5;
}
export interface BeepCommand {
  type: "beep";
}

/** One ESC/POS command. Send a list of these as `commands`. */
export type EscposCommand =
  | TextCommand
  | FeedCommand
  | LineCommand
  | ColumnsCommand
  | BarcodeCommand
  | QrCommand
  | ImageCommand
  | CutCommand
  | DrawerCommand
  | BeepCommand;
