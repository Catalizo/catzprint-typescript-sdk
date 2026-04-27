/**
 * Thrown when the print service API returns an error response (4xx / 5xx).
 */
export declare class PrintingException extends Error {
    constructor(message: string);
}
/**
 * Thrown when a network-level error occurs while contacting the API
 * (e.g. DNS failure, timeout, TLS error).
 */
export declare class ApiConnectionException extends Error {
    constructor(message: string);
}
//# sourceMappingURL=errors.d.ts.map