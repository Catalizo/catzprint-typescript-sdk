import { ApiClient } from './ApiClient.js';
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
export declare class Printing {
    private readonly apiClient;
    private _content?;
    private _orderId?;
    private constructor();
    /** Create a new print task attached to the given {@link ApiClient}. */
    static newPrintTask(apiClient: ApiClient): Printing;
    /**
     * Set the JSON content of the print job (e.g. from {@link ReceiptPrinter.getJson}).
     */
    content(json: string): this;
    /** Associate an order ID with this print job. */
    orderId(orderId: string | number): this;
    /**
     * Submit the print job.
     *
     * @returns The print-job ID (`pjId`) returned by the API.
     * @throws {PrintingException} If content is empty or the API returns an error.
     */
    send(): Promise<string>;
}
//# sourceMappingURL=Printing.d.ts.map