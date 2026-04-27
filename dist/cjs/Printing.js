"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Printing = void 0;
const errors_js_1 = require("./errors.js");
/**
 * Fluent builder for submitting a print job to the CatzPrint API.
 *
 * @example
 * ```ts
 * const pjId = await Printing.newPrintTask(client)
 *   .orderId('order-123')
 *   .content(receipt.getJson())
 *   .send();
 * ```
 */
class Printing {
    constructor(apiClient) {
        this.apiClient = apiClient;
    }
    /** Create a new print task attached to the given {@link ApiClient}. */
    static newPrintTask(apiClient) {
        return new Printing(apiClient);
    }
    /**
     * Set the JSON content of the print job (e.g. from {@link ReceiptPrinter.getJson}).
     */
    content(json) {
        this._content = json;
        return this;
    }
    /** Associate an order ID with this print job. */
    orderId(orderId) {
        this._orderId = orderId;
        return this;
    }
    /**
     * Submit the print job.
     *
     * @returns The print-job ID (`pjId`) returned by the API.
     * @throws {PrintingException} If content is empty or the API returns an error.
     */
    async send() {
        if (!this._content?.trim()) {
            throw new errors_js_1.PrintingException('Print content cannot be empty');
        }
        const payload = {
            source: 'typescript',
            content: this._content,
            orderId: this._orderId,
        };
        const response = await this.apiClient.sendRequest('/print-job', 'POST', payload);
        return response.data?.pjId ?? '';
    }
}
exports.Printing = Printing;
//# sourceMappingURL=Printing.js.map