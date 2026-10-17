import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  CatzPrintError,
  ConflictError,
  NotFoundError,
  OutOfPrintsError,
  PermissionError,
  RateLimitError,
  ServerError,
  ValidationError,
  errorFromResponse,
} from "../../src/index.js";
import { parseRetryAfter } from "../../src/errors.js";

const body = (code: string, message = "msg", extra: Record<string, unknown> = {}) => ({ error: { code, message, ...extra } });

describe("errorFromResponse", () => {
  const cases: [number, string, new (...a: any[]) => CatzPrintError][] = [
    [400, "invalid", ValidationError],
    [422, "no_printer", ValidationError],
    [401, "invalid_api_key", AuthenticationError],
    [402, "out_of_prints", OutOfPrintsError],
    [403, "forbidden", PermissionError],
    [404, "not_found", NotFoundError],
    [409, "invalid_state", ConflictError],
    [429, "rate_limited", RateLimitError],
    [500, "internal", ServerError],
    [503, "unavailable", ServerError],
  ];
  for (const [status, code, cls] of cases) {
    it(`maps ${status} ${code} to ${cls.name}`, () => {
      const e = errorFromResponse(status, body(code, "Nope."));
      expect(e).toBeInstanceOf(cls);
      expect(e).toBeInstanceOf(CatzPrintError);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe(cls.name);
      expect(e.status).toBe(status);
      expect(e.code).toBe(code);
      expect(e.message).toBe("Nope.");
    });
  }

  it("maps code out_of_prints whatever the status", () => {
    expect(errorFromResponse(403, body("out_of_prints"))).toBeInstanceOf(OutOfPrintsError);
  });

  it("keeps field errors", () => {
    const e = errorFromResponse(400, body("invalid", "Unknown printer.", { fields: { printer_id: "Unknown printer." } }));
    expect(e.fields).toEqual({ printer_id: "Unknown printer." });
  });

  it("reads retry_after_seconds, else the Retry-After header", () => {
    expect(errorFromResponse(429, body("rate_limited", "x", { retry_after_seconds: 7 })).retryAfter).toBe(7);
    const h = new Headers({ "retry-after": "3", "x-request-id": "req_1" });
    const e = errorFromResponse(429, body("rate_limited"), h);
    expect(e.retryAfter).toBe(3);
    expect(e.requestId).toBe("req_1");
  });

  it("copes with a non-JSON or empty body", () => {
    const e = errorFromResponse(502, undefined);
    expect(e).toBeInstanceOf(ServerError);
    expect(e.code).toBe("server_error");
    expect(e.fields).toEqual({});
    expect(errorFromResponse(418, "teapot").code).toBe("http_418");
  });

  it("parses Retry-After dates", () => {
    const now = Date.parse("2026-10-16T00:00:00Z");
    expect(parseRetryAfter("Fri, 16 Oct 2026 00:00:05 GMT", now)).toBe(5);
    expect(parseRetryAfter("garbage")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
