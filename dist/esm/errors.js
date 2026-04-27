/**
 * Thrown when the print service API returns an error response (4xx / 5xx).
 */
export class PrintingException extends Error {
    constructor(message) {
        super(message);
        this.name = 'PrintingException';
        Object.setPrototypeOf(this, PrintingException.prototype);
    }
}
/**
 * Thrown when a network-level error occurs while contacting the API
 * (e.g. DNS failure, timeout, TLS error).
 */
export class ApiConnectionException extends Error {
    constructor(message) {
        super(message);
        this.name = 'ApiConnectionException';
        Object.setPrototypeOf(this, ApiConnectionException.prototype);
    }
}
//# sourceMappingURL=errors.js.map