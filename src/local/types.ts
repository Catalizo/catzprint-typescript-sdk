// Types for local printing. Browser-safe: no imports of Node built-ins.

/** Where `jobs.create` sends jobs. */
export type LocalMode = "cloud" | "local" | "local_first" | "cloud_first";

/** A station's local-network address as the cloud knows it (`GET /v1/orgs/{org}/local-endpoints`). */
export interface LocalEndpoint {
  station_id: string;
  name: string;
  location_id: string | null;
  connected: boolean;
  local_enabled: boolean;
  port: number;
  /** Private IPv4 addresses. */
  addresses: string[];
  /** Public-certificate hostnames first, then raw IP URLs. */
  urls: string[];
  tls_mode: "public" | "self_signed" | string;
  /** Hex SHA-256 of the station certificate (DER). Pinned for IP and self-signed URLs. */
  cert_fingerprint_sha256: string;
  /** Hex SHA-256 of the public certificate's SubjectPublicKeyInfo; pinned for hostnames. */
  public_spki_sha256?: string;
  /** The station's label in `<a-b-c-d>.<label>.<zone>`. */
  local_label?: string;
  updated_at: string;
}

/** A minted local token (`czl1…`), verified by stations offline. */
export interface LocalToken {
  token: string;
  token_id: string;
  expires_at: string;
  stations: LocalEndpoint[];
}

/** A job as a station's local API reports it. */
export interface LocalJob {
  id: string;
  idempotency_key: string;
  status: "queued" | "printing" | "printed" | "failed";
  error_code?: string;
  detail: string;
  printer_id: string;
  printer_name: string;
  role: string;
  location_id: string;
  copies: number;
  title: string;
  reference: string;
  created_at: string;
  finished_at: string | null;
  printed_locally: true;
  via: "local";
  cloud_job_id: string | null;
  /** False for jobs sent with a test-mode token. */
  live?: boolean;
  /** The station URL that answered (set by the SDK). */
  station_url?: string;
}

/** A station's `GET /local/v1/status` answer. */
export interface LocalStatus {
  station: {
    id: string;
    name: string;
    cloud_connected: boolean;
    last_cloud_contact: string | null;
    version: string;
    local_enabled: boolean;
  };
  printers: Array<{
    id: string;
    name: string;
    role: string;
    status: "ready" | "offline" | "paper_out" | "paper_low" | "cover_open" | "error" | "busy" | "unknown" | string;
    paper: "ok" | "low" | "out" | "unknown" | string;
    jobs_waiting: number;
  }>;
  jobs_waiting: number;
  /** Local jobs the station still has to report to the cloud. */
  unsynced: number;
  allowance: { expires_at: string | null; prints_left: number };
  /** The station URL that answered (set by the SDK). */
  station_url?: string;
}

/** A station's unauthenticated `GET /local/v1/info` answer. */
export interface LocalInfo {
  station_id: string;
  name: string;
  org_id: string;
  location_id: string;
  version: string;
  port: number;
  tls_mode: string;
  cert_fingerprint_sha256: string;
  hostnames: string[];
  addresses: string[];
  pairing_open: boolean;
  time: string;
}

/** The result of pairing: a device token (`czd_…`) for one station. */
export interface LocalPairing {
  token: string;
  deviceId: string;
  stationId: string;
  orgId: string;
  locationId: string;
}

/** Content and routing for a local job (camelCase, like `jobs.create`). */
export interface LocalPrintParams {
  printerId?: string;
  locationId?: string;
  role?: string;
  kind?: "commands" | "template" | "text" | "escpos" | "test";
  commands?: unknown[];
  templateId?: string;
  data?: Record<string, unknown>;
  /** Plain text, or base64 for `kind: "escpos"`. */
  content?: string;
  /** Shortcut for `kind: "text"` with `content`. */
  text?: string;
  title?: string;
  reference?: string;
  copies?: number;
  /** ≤200 characters. Generated as `sdk-<uuid v4>` when omitted. */
  idempotencyKey?: string;
  options?: Record<string, unknown>;
}
