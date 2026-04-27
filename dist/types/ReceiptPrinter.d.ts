/** Alignment values accepted by the printer. */
export type Alignment = 'left' | 'center' | 'right';
/** Discriminated-union type for every command the printer understands. */
export type PrinterCommand = {
    action: 'setTextSize';
    width: number;
    height: number;
} | {
    action: 'align';
    value: Alignment;
} | {
    action: 'text';
    content: string;
} | {
    action: 'twoColumnText';
    left: string;
    right: string;
} | {
    action: 'line';
} | {
    action: 'feed';
    lines: number;
} | {
    action: 'cut';
};
/**
 * Fluent builder that composes an array of ESC/POS-style printer commands
 * and serialises them to JSON for use with the CatzPrint API.
 *
 * @example
 * ```ts
 * const json = new ReceiptPrinter()
 *   .centerAlign()
 *   .setTextSize(2, 2)
 *   .text('ACME Store')
 *   .setTextSize(1, 1)
 *   .line()
 *   .twoColumnText('Item A', '$5.00')
 *   .line()
 *   .feed(2)
 *   .cut()
 *   .getJson();
 * ```
 */
export declare class ReceiptPrinter {
    private readonly commands;
    /**
     * Set character size multiplier.
     * @param width  Horizontal scale (≥ 1).
     * @param height Vertical scale (≥ 1).
     */
    setTextSize(width: number, height: number): this;
    /** Align subsequent text to the centre. */
    centerAlign(): this;
    /** Align subsequent text to the left. */
    leftAlign(): this;
    /** Align subsequent text to the right. */
    rightAlign(): this;
    /**
     * Print a line of text.
     * @throws {Error} If `content` is blank.
     */
    text(content: string): this;
    /** Print two strings side-by-side (left / right columns). */
    twoColumnText(left: string, right: string): this;
    /** Print a full-width horizontal rule. */
    line(): this;
    /**
     * Advance paper by `lines` blank lines.
     * @param lines Number of lines to feed (≥ 1). Default: `1`.
     */
    feed(lines?: number): this;
    /** Cut the paper. */
    cut(): this;
    /**
     * Return the accumulated commands as a pretty-printed JSON string.
     * @throws {Error} If no commands have been added.
     */
    getJson(): string;
    /** Alias for {@link getJson} — allows template literal usage. */
    toString(): string;
    /** Return a shallow copy of the commands array. */
    getCommands(): ReadonlyArray<PrinterCommand>;
}
//# sourceMappingURL=ReceiptPrinter.d.ts.map