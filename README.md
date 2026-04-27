# @catalizo/catzprint

TypeScript SDK for the [CatzPrint](https://catzprint.com) remote printing service.

## Installation

```bash
npm install @catalizo/catzprint
# or
yarn add @catalizo/catzprint
# or
pnpm add @catalizo/catzprint
```

Requires **Node.js ≥ 18** (uses the native `fetch` API).

---

## Quick start

```ts
import { ApiClient, ReceiptPrinter, Printing } from '@catalizo/catzprint';

const client = new ApiClient({ apiKey: 'YOUR_API_KEY' });

const receipt = new ReceiptPrinter()
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

const pjId = await Printing.newPrintTask(client)
  .orderId('order-123')
  .content(receipt.getJson())
  .send();

console.log('Print job ID:', pjId);
```

---

## API reference

### `ApiClient`

```ts
new ApiClient(options: ApiClientOptions)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | **required** | Bearer token |
| `baseUrl` | `string` | `https://api.catzprint.com/api/v1/sdk` | Override for self-hosted |
| `timeoutMs` | `number` | `10000` | Request timeout in ms |

---

### `ReceiptPrinter`

Fluent builder for constructing receipt command sequences.

| Method | Description |
|---|---|
| `.setTextSize(w, h)` | Set character size multiplier (both ≥ 1) |
| `.centerAlign()` | Centre-align subsequent text |
| `.leftAlign()` | Left-align subsequent text |
| `.rightAlign()` | Right-align subsequent text |
| `.text(content)` | Print a line of text |
| `.twoColumnText(left, right)` | Print two columns side by side |
| `.line()` | Print a horizontal rule |
| `.feed(lines?)` | Advance paper (default: 1 line) |
| `.cut()` | Cut the paper |
| `.getJson()` | Serialise commands to JSON string |
| `.getCommands()` | Return a readonly copy of the command array |

---

### `Printing`

```ts
Printing.newPrintTask(client)
  .content(json)      // JSON from ReceiptPrinter.getJson()
  .orderId('ord-1')   // optional
  .send()             // Promise<string> – returns pjId
```

---

### Errors

| Class | When thrown |
|---|---|
| `PrintingException` | API returned 4xx / 5xx, or content is empty |
| `ApiConnectionException` | Network-level error (DNS, timeout, TLS) |

```ts
import { PrintingException, ApiConnectionException } from '@catalizo/catzprint';

try {
  await Printing.newPrintTask(client).content(json).send();
} catch (err) {
  if (err instanceof ApiConnectionException) {
    console.error('Could not reach the server:', err.message);
  } else if (err instanceof PrintingException) {
    console.error('Print job failed:', err.message);
  }
}
```

---

## Development

```bash
npm install
npm run build       # compile ESM + CJS + type declarations
npm test            # run Jest test suite
npm run test:coverage
```

---

## License

MIT © [Catalizo Digital Solutions LLC](mailto:developers@catalizo.com)
