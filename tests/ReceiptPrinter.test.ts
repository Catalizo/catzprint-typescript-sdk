import { ReceiptPrinter } from '../src/ReceiptPrinter';

describe('ReceiptPrinter', () => {
  it('builds a complete receipt command sequence', () => {
    const printer = new ReceiptPrinter()
      .centerAlign()
      .setTextSize(2, 2)
      .text('ACME Store')
      .setTextSize(1, 1)
      .line()
      .twoColumnText('Item A', '$5.00')
      .twoColumnText('Item B', '$3.50')
      .line()
      .feed(2)
      .cut();

    const commands = printer.getCommands();
    expect(commands).toHaveLength(10);
    expect(commands[0]).toEqual({ action: 'align', value: 'center' });
    expect(commands[1]).toEqual({ action: 'setTextSize', width: 2, height: 2 });
    expect(commands[9]).toEqual({ action: 'cut' });
  });

  it('serialises to valid JSON', () => {
    const json = new ReceiptPrinter().text('Hello').getJson();
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('toString() returns same as getJson()', () => {
    const p = new ReceiptPrinter().text('Hi').cut();
    expect(p.toString()).toBe(p.getJson());
  });

  it('throws when getJson() is called with no commands', () => {
    expect(() => new ReceiptPrinter().getJson()).toThrow('No commands to encode');
  });

  it('throws on empty text', () => {
    expect(() => new ReceiptPrinter().text('   ')).toThrow('cannot be empty');
  });

  it('throws on invalid text size', () => {
    expect(() => new ReceiptPrinter().setTextSize(0, 1)).toThrow(RangeError);
    expect(() => new ReceiptPrinter().setTextSize(1, 0)).toThrow(RangeError);
  });

  it('throws on invalid feed count', () => {
    expect(() => new ReceiptPrinter().feed(0)).toThrow(RangeError);
  });

  it('supports leftAlign and rightAlign', () => {
    const commands = new ReceiptPrinter()
      .leftAlign()
      .rightAlign()
      .text('x')
      .getCommands();
    expect(commands[0]).toEqual({ action: 'align', value: 'left' });
    expect(commands[1]).toEqual({ action: 'align', value: 'right' });
  });

  it('getCommands() returns a copy, not the internal array', () => {
    const p = new ReceiptPrinter().text('a');
    const cmds = p.getCommands() as unknown[];
    (cmds as unknown[]).push({ action: 'cut' });
    expect(p.getCommands()).toHaveLength(1);
  });
});
