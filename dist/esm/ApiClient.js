import { ApiConnectionException, PrintingException } from './errors.js';
/**
 * Low-level HTTP client for the CatzPrint API.
 * Uses the native `fetch` API (Node ≥ 18, all modern browsers).
 */
export class ApiClient {
    constructor(options) {
        this.apiKey = options.apiKey;
        this.baseUrl = (options.baseUrl ?? 'https://api.catzprint.com/api/v1/sdk').replace(/\/$/, '');
        this.timeoutMs = options.timeoutMs ?? 10000;
    }
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
    async sendRequest(endpoint, method = 'POST', data) {
        const url = `${this.baseUrl}/${endpoint.replace(/^\//, '')}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let response;
        try {
            response = await fetch(url, {
                method: method.toUpperCase(),
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'User-Agent': 'catzprint-ts/1.0.0',
                },
                body: data !== undefined ? JSON.stringify(data) : undefined,
                signal: controller.signal,
            });
        }
        catch (err) {
            clearTimeout(timer);
            const message = err instanceof Error ? err.message : 'Unknown network error';
            throw new ApiConnectionException(`Network error: ${message}`);
        }
        finally {
            clearTimeout(timer);
        }
        let body;
        try {
            body = (await response.json());
        }
        catch {
            body = {};
        }
        if (!response.ok) {
            const errorPayload = body.error;
            const detail = typeof errorPayload === 'object'
                ? (errorPayload?.message ?? JSON.stringify(errorPayload))
                : (errorPayload ?? response.statusText);
            throw new PrintingException(`API Error ${response.status}: ${String(detail).slice(0, 200)}`);
        }
        return body;
    }
}
//# sourceMappingURL=ApiClient.js.map