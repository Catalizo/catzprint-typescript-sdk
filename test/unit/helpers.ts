import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
  json: any;
}

export type Handler = (req: Recorded, res: ServerResponse, n: number) => void;

/** A tiny local HTTP server that records every request. */
export async function fakeApi(handler: Handler) {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let json: any;
      try {
        json = body ? JSON.parse(body) : undefined;
      } catch {
        json = undefined;
      }
      const r: Recorded = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body, json };
      requests.push(r);
      handler(r, res, requests.length);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

export function apiError(res: ServerResponse, status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  send(res, status, { error: { code, message, ...extra } }, headers);
}

export const ORG = "34c4671b-d2ab-4ddf-aaac-615786d5acac";
export const KEY = "cz_test_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";

export function job(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    live: false,
    source: "api",
    kind: "escpos",
    status: "queued",
    status_detail: "",
    title: "",
    reference: "",
    copies: 1,
    printer_id: null,
    printer_name: null,
    station_id: null,
    station_name: null,
    location_id: null,
    location_name: null,
    size: 10,
    attempts: 0,
    billed_as: "test",
    created_by: null,
    reprint_of: null,
    scheduled_for: null,
    created_at: "2026-10-16T00:00:00Z",
    sent_at: null,
    printed_at: null,
    finished_at: null,
    ...over,
  };
}
