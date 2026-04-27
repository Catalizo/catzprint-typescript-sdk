export interface ApiClientOptions {
    /** Bearer token for authentication. */
    apiKey: string;
    /** Override the base URL (useful for self-hosted instances or testing). */
    baseUrl?: string;
    /** Request timeout in milliseconds. Default: 10 000. */
    timeoutMs?: number;
}
/**
 * Low-level HTTP client for the CatzPrint API.
 * Uses the native `fetch` API (Node ≥ 18, all modern browsers).
 */
export declare class ApiClient {
    readonly baseUrl: string;
    private readonly apiKey;
    private readonly timeoutMs;
    constructor(options: ApiClientOptions);
    /**
     * Send an authenticated request to the CatzPrint API.
     *
     * @param endpoint  Path relative to `baseUrl` (leading slash optional).
     * @param method    HTTP verb. Default: `'POST'`.
     * @param data      Request body (serialised as JSON when provided).
     * @returns         Parsed JSON response body.
     *
     * @throws {ApiConnectionException} Network / fetch-level errors.
     * @throws {PrintingException}      HTTP 4xx / 5xx responses.
     */
    sendRequest<T = Record<string, unknown>>(endpoint: string, method?: string, data?: Record<string, unknown>): Promise<T>;
}
//# sourceMappingURL=ApiClient.d.ts.map