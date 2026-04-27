"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiConnectionException = exports.PrintingException = void 0;
/**
 * Thrown when the print service API returns an error response (4xx / 5xx).
 */
class PrintingException extends Error {
    constructor(message) {
        super(message);
        this.name = 'PrintingException';
        Object.setPrototypeOf(this, PrintingException.prototype);
    }
}
exports.PrintingException = PrintingException;
/**
 * Thrown when a network-level error occurs while contacting the API
 * (e.g. DNS failure, timeout, TLS error).
 */
class ApiConnectionException extends Error {
    constructor(message) {
        super(message);
        this.name = 'ApiConnectionException';
        Object.setPrototypeOf(this, ApiConnectionException.prototype);
    }
}
exports.ApiConnectionException = ApiConnectionException;
//# sourceMappingURL=errors.js.map