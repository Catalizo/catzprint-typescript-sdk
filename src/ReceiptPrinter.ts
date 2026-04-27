/** Alignment values accepted by the printer. */
export type Alignment = 'left' | 'center' | 'right';

/** Discriminated-union type for every command the printer understands. */
export type PrinterCommand =
  | { action: 'setTextSize'; width: number; height: number }
  | { action: 'align'; value: Alignment }
  | { action: 'text'; content: string }
  | { action: 'twoColumnText'; left: string; right: string }
  | { action: 'line' }
  | { action: 'feed'; lines: number }
  | { action: 'cut' };

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
export class ReceiptPrinter {
  private readonly commands: PrinterCommand[] = [];

  // ── Text sizing ──────────────────────────────────────────────────────────

  /**
   * Set character size multiplier.
   * @param width  Horizontal scale (≥ 1).
   * @param height Vertical scale (≥ 1).
   */
  setTextSize(width: number, height: number): this {
    if (width < 1 || height < 1) {
      throw new RangeError('Text size must be positive integers');
    }
    this.commands.push({ action: 'setTextSize', width, height });
    return this;
  }

  // ── Alignment ────────────────────────────────────────────────────────────

  /** Align subsequent text to the centre. */
  centerAlign(): this {
    this.commands.push({ action: 'align', value: 'center' });
    return this;
  }

  /** Align subsequent text to the left. */
  leftAlign(): this {
    this.commands.push({ action: 'align', value: 'left' });
    return this;
  }

  /** Align subsequent text to the right. */
  rightAlign(): this {
    this.commands.push({ action: 'align', value: 'right' });
    return this;
  }

  // ── Content ──────────────────────────────────────────────────────────────

  /**
   * Print a line of text.
   * @throws {Error} If `content` is blank.
   */
  text(content: string): this {
    if (!content.trim()) {
      throw new Error('Text content cannot be empty');
    }
    this.commands.push({ action: 'text', content });
    return this;
  }

  /** Print two strings side-by-side (left / right columns). */
  twoColumnText(left: string, right: string): this {
    this.commands.push({ action: 'twoColumnText', left, right });
    return this;
  }

  /** Print a full-width horizontal rule. */
  line(): this {
    this.commands.push({ action: 'line' });
    return this;
  }

  // ── Paper control ────────────────────────────────────────────────────────

  /**
   * Advance paper by `lines` blank lines.
   * @param lines Number of lines to feed (≥ 1). Default: `1`.
   */
  feed(lines: number = 1): this {
    if (lines < 1) {
      throw new RangeError('Feed lines must be at least 1');
    }
    this.commands.push({ action: 'feed', lines });
    return this;
  }

  /** Cut the paper. */
  cut(): this {
    this.commands.push({ action: 'cut' });
    return this;
  }

  // ── Serialisation ────────────────────────────────────────────────────────

  /**
   * Return the accumulated commands as a pretty-printed JSON string.
   * @throws {Error} If no commands have been added.
   */
  getJson(): string {
    if (this.commands.length === 0) {
      throw new Error('No commands to encode');
    }
    return JSON.stringify(this.commands, null, 2);
  }

  /** Alias for {@link getJson} — allows template literal usage. */
  toString(): string {
    return this.getJson();
  }

  /** Return a shallow copy of the commands array. */
  getCommands(): ReadonlyArray<PrinterCommand> {
    return [...this.commands];
  }
}
