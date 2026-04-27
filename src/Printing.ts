import { ApiClient } from './ApiClient.js';
import { PrintingException } from './errors.js';

interface PrintJobResponse {
  data?: { pjId?: string };
}

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
export class Printing {
  private _content?: string;
  private _orderId?: string | number;

  private constructor(private readonly apiClient: ApiClient) {}

  /** Create a new print task attached to the given {@link ApiClient}. */
  static newPrintTask(apiClient: ApiClient): Printing {
    return new Printing(apiClient);
  }

  /**
   * Set the JSON content of the print job (e.g. from {@link ReceiptPrinter.getJson}).
   */
  content(json: string): this {
    this._content = json;
    return this;
  }

  /** Associate an order ID with this print job. */
  orderId(orderId: string | number): this {
    this._orderId = orderId;
    return this;
  }

  /**
   * Submit the print job.
   *
   * @returns The print-job ID (`pjId`) returned by the API.
   * @throws {PrintingException} If content is empty or the API returns an error.
   */
  async send(): Promise<string> {
    if (!this._content?.trim()) {
      throw new PrintingException('Print content cannot be empty');
    }

    const payload: Record<string, unknown> = {
      source: 'typescript',
      content: this._content,
      orderId: this._orderId,
    };

    const response = await this.apiClient.sendRequest<PrintJobResponse>(
      '/print-job',
      'POST',
      payload,
    );

    return response.data?.pjId ?? '';
  }
}
