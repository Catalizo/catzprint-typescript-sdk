# CatzPrint Node.js SDK

The official Node.js / TypeScript client for the [CatzPrint](https://catzprint.com) cloud printing API.
Send receipts, PDFs, images and templates to any printer in your organization, wait for them to print,
and verify webhooks.

- ESM and CommonJS, with TypeScript types
- **Zero runtime dependencies**: global `fetch` and `node:crypto`
- Node.js 18 or newer
- Automatic retries with backoff, safe for job creation (idempotency keys)
- Client-side encryption of print content (NaCl sealed boxes)

## Install

```sh
npm install catzprint
```

## Quickstart

```ts
import { CatzPrint } from "catzprint";

const cz = new CatzPrint({ apiKey: process.env.CATZPRINT_API_KEY });

const printers = await cz.printers.list();
const job = await cz.printText("Hello from CatzPrint!", { printerId: printers[0].id });
const done = await cz.jobs.waitFor(job.id);
console.log(done.status); // "printed"
```

CommonJS works too: `const { CatzPrint } = require("catzprint");`

## Configuration

```ts
const cz = new CatzPrint({
  apiKey: "cz_live_…",          // or the CATZPRINT_API_KEY environment variable
  baseUrl: "https://api-v1.catzprint.com", // or CATZPRINT_BASE_URL
  orgId: "…",                   // optional; looked up from the key on first use
  timeoutMs: 30_000,            // per request
  maxRetries: 2,                // network errors, 429, 502/503/504
  maxRetryAfterSeconds: 60,     // longer Retry-After → throw RateLimitError instead of waiting
  fetch: customFetch,           // optional
});
```

Every API key belongs to one organization. The SDK calls `GET /v1/key` once to learn the organization ID
and caches it; pass `orgId` to skip that call.

The key is never logged: `String(cz)`, `JSON.stringify(cz)` and `console.log(cz)` show `cz_live_****`.

### Test and live keys

| Key | Delivery | Billed | `job.live` | `job.billed_as` |
|---|---|---|---|---|
| `cz_live_…` | normal | yes (counts toward your monthly prints) | `true` | your plan |
| `cz_test_…` | delivered to the station like live jobs, marked as test | never | `false` | `"test"` |

Use test keys in development and CI. `cz.mode` tells you which one a client uses. Test keys can only
cancel, retry or reprint test jobs.

## API reference

All methods return promises. Models use the API's field names (`printer_id`, `created_at`, …).

### Key

```ts
const key = await cz.key();     // { id, org_id, org_name, live, scopes }
const same = await cz.whoami(); // alias
const orgId = await cz.orgId();
```

### Printing

`jobs.create(params)` is the general call. Pass **one** content source: `text`, `commands`,
`templateId` (+ `data`) or `content` (bytes).

```ts
const job = await cz.jobs.create({
  printerId: "…",            // or locationId / role: "receipt" | "kitchen" | "bar" | "label" | "office" | "other"
  text: "Table 4: 2 x soup",
  title: "Kitchen ticket",
  reference: "order-1042",   // your own reference, searchable
  copies: 2,                 // 1..50
  idempotencyKey: "order-1042-kitchen", // optional; the SDK generates one if you don't
  scheduledFor: new Date(Date.now() + 15 * 60_000), // optional, up to 30 days ahead
  options: { anything: "you want stored with the job" },
});
```

Content sources:

| Param | Kind | Notes |
|---|---|---|
| `text: string` | `text` | Receipt printers print it as-is; office printers get a PDF. |
| `commands: EscposCommand[]` | `commands` | See [ESC/POS commands](#escpos-commands). |
| `templateId` + `data` | `template` | A template saved in the console. |
| `content: Uint8Array \| Buffer \| ArrayBuffer` | detected | PDF and PNG/JPEG are detected; set `kind` (`"pdf"`, `"image"`, `"escpos"`, `"text"`) or `fileName` (e.g. `"menu.docx"`, converted by the server) otherwise. |
| `sealed: true` | | Encrypts `text`/`content` to the server key before sending. |

Helpers for the common cases:

```ts
await cz.printText("Hello", { printerId });
await cz.printPdf("./invoice.pdf", { printerId, sealed: true }); // path or bytes; title defaults to the file name
await cz.printImage(pngBuffer, { role: "label" });               // PNG or JPEG
await cz.printReceipt([{ type: "text", text: "Hi" }, { type: "cut" }], { role: "receipt" });
await cz.printTemplate(templateId, { order: "1042", total: "9.99" }, { locationId });
```

Routing: give `printerId` to choose a printer, or `role` and/or `locationId` to let your routing rules
(or the best ready printer with that role) decide.

Printer names aren't unique (two stations can each have a "Kitchen"), so target printers by ID. `printers.list` returns each printer's `id`, `station_id`, `station_name`, `location_id` and `role`. Optional shortcut: in the CatzPrint console, open **Locations & stations** (**My devices** in a personal account), then a station, and click the ID under a printer's name to copy it.

### Jobs

```ts
const job = await cz.jobs.get(id);         // Job + events: [{ at, status, detail, actor }]

const page = await cz.jobs.list({
  status: ["failed", "held"],              // or one status
  printerId, stationId, locationId,
  live: true,                              // live or test jobs only
  q: "order-1042",                         // reference, title or ID prefix
  since: new Date("2026-10-01"),
  limit: 50,                               // 1..200
  cursor: undefined,                       // page.next_cursor of the previous page
  counts: true,                            // page.counts per status (last 24h)
});
page.items; page.next_cursor;

// Every page, fetched as you go:
for await (const job of cz.jobs.iterate({ status: "failed" })) {
  console.log(job.id, job.status_detail);
}

await cz.jobs.cancel(id);                          // scheduled, held, queued or sent jobs
await cz.jobs.retry(id);                           // failed or held jobs
await cz.jobs.reprint(id, { printerId, copies });  // a new job with the same content

const done = await cz.jobs.waitFor(id, { timeoutMs: 60_000, intervalMs: 1_000 });
// resolves when status is printed, failed or cancelled; throws TimeoutError otherwise
```

Statuses: `scheduled`, `held`, `queued`, `sent`, `printing`, `printed`, `failed`, `cancelled`.

### Printers, locations, templates

```ts
const printers = await cz.printers.list();               // [{ id, name, role, status, capabilities, … }]
const onStation = await cz.printers.list({ stationId });
const locations = await cz.locations.list();
const location = await cz.locations.get(locationId);
const templates = await cz.templates.list();             // [{ id, name, paper, body, version, … }]
```

Scopes: `printers:read`, `locations:read`, `jobs:read` (get/list), `jobs:write` (create, cancel, retry,
reprint, templates).

### ESC/POS commands

```ts
import type { EscposCommand } from "catzprint";

const receipt: EscposCommand[] = [
  { type: "text", text: "Corner Café", align: "center", bold: true, size: 2 },
  { type: "line" },                                      // char: "=" to change the rule
  { type: "columns", columns: [{ text: "Flat white", width: 0.75 }, { text: "3.50", align: "right" }] },
  { type: "feed", lines: 1 },
  { type: "barcode", data: "1042", format: "code128" },  // code128, ean13, code39
  { type: "qr", data: "https://example.com/r/1042", align: "center" },
  { type: "image", data: pngBase64 },
  { type: "drawer" },                                    // open the cash drawer (pin 2 or 5)
  { type: "beep" },
  { type: "cut", partial: true },
];
```

Text options: `align`, `bold`, `underline`, `invert`, `size` (1–8), `font` (`"a"`/`"b"`). Columns: 1–6
cells with `text`, `width` (fraction of the line), `align`, `bold`.

## Errors

Every API error is a `CatzPrintError` with `status`, `code`, `message`, `fields` and `retryAfter`
(seconds). Catch the subclass you care about:

| Class | When |
|---|---|
| `AuthenticationError` | 401: missing, invalid, revoked or expired key |
| `PermissionError` | 403: the key lacks a scope, or the action isn't allowed |
| `NotFoundError` | 404 |
| `ValidationError` | 400 / 422: see `err.fields`, e.g. `{ printer_id: "Unknown printer." }` |
| `OutOfPrintsError` | 402 / `out_of_prints`: no prints left this month |
| `ConflictError` | 409: e.g. cancelling a printed job |
| `RateLimitError` | 429: wait `err.retryAfter` seconds |
| `ServerError` | 5xx |
| `ConnectionError` | network failure or timeout (`code` is `connection_error` or `timeout`) |

Outside API calls: `TimeoutError` (from `jobs.waitFor`, with `jobId` and `lastJob`) and
`SignatureVerificationError` (from webhook verification).

```ts
import { CatzPrint, ValidationError, OutOfPrintsError, CatzPrintError } from "catzprint";

try {
  await cz.printText("Hi", { printerId });
} catch (err) {
  if (err instanceof ValidationError) console.error(err.fields);
  else if (err instanceof OutOfPrintsError) console.error("Upgrade to keep printing");
  else if (err instanceof CatzPrintError) console.error(err.status, err.code, err.message);
  else throw err;
}
```

## Retries and idempotency

- Network errors, timeouts, `429` and `502`/`503`/`504` are retried up to `maxRetries` times (default 2)
  with exponential backoff and jitter (0.25–0.5 s, 0.5–1 s, …, at most 8 s).
- On `429` (or any of these with `Retry-After`) the SDK waits at least as long as the API asks, unless
  that's longer than `maxRetryAfterSeconds`; then it throws `RateLimitError` at once.
- `GET` requests are always safe to retry. **A `POST` is only retried when it carries an idempotency
  key.** `jobs.create` (and every print helper) always sends one: yours, or a UUID v4 the SDK generates.
  The same key is reused across retries, so a job is never printed twice because of a retry. The API
  returns the original job for a key it has seen.
- `jobs.cancel`, `jobs.retry` and `jobs.reprint` are never retried automatically.

Pass your own key to make a create safe across process restarts too, e.g. one per order:

```ts
await cz.printReceipt(commands, { role: "kitchen", idempotencyKey: `order-${order.id}-kitchen` });
```

## Sealed printing

With `sealed: true` the SDK fetches the server's public key once (`GET /v1/public/server-key`, cached)
and encrypts the content with a NaCl sealed box (X25519 + XSalsa20-Poly1305, libsodium's
`crypto_box_seal`) before it leaves your process. Only the CatzPrint server can open it; it then seals
the job again to the receiving station's own key.

```ts
await cz.printPdf(pdfBytes, { printerId, sealed: true });
await cz.printText("PIN: 4821", { printerId, sealed: true });
const b64 = await cz.seal(bytes); // the raw building block, if you need it
```

Sealing works with `text` and `content`; commands and templates are rendered by the server and are
sent over TLS only.

**Why no crypto dependency:** `node:crypto` provides X25519 (OpenSSL) but not XSalsa20, Poly1305 or
BLAKE2b with a 24-byte output, which a sealed box needs. Rather than add `tweetnacl` plus a BLAKE2b
package, the SDK carries those three primitives (about 250 lines in `src/nacl.ts`, written from their
specifications). They are tested against the published RFC 8439 Poly1305 vectors, RFC 7693 BLAKE2b,
NaCl's own HSalsa20/XSalsa20 vectors, `node:crypto`'s BLAKE2b-512, and, most importantly, against
libsodium itself: the test suite has PyNaCl open SDK-sealed boxes of 18 sizes from 0 bytes to 1 MiB and
checks the output byte for byte for a fixed ephemeral key. The X25519 scalar multiplication runs in
OpenSSL. Salsa20 and Poly1305 (including Poly1305's final reduction, done on fixed-size limbs rather than
BigInt) are written without secret-dependent branches, loop counts or table lookups; BLAKE2b only hashes
public keys. That is a property of the source code: a JavaScript engine gives no formal constant-time
guarantee, so treat this as best-effort side-channel resistance rather than an audited constant-time
implementation. Integration tests also confirm the live server opens these boxes.

## Webhooks

CatzPrint signs every delivery with your endpoint's secret:
`CatzPrint-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`.
`webhooks.verify` checks the signature in constant time (any of several `v1` values may match, for
secret rotation), rejects timestamps more than 300 s off (change with `{ tolerance }`), and returns the
parsed event. `constructEvent` is an alias. You don't need an API key to verify webhooks.

Every event carries `event.id`, the delivery id, which stays the same across retries. **Deduplicate on
`event.id`**: the timestamp check limits the replay window to 5 minutes, it does not stop a captured delivery
from being replayed within that window (and retries can deliver the same event twice).

Always pass the **raw** body, exactly as received.

### Express

```ts
import express from "express";
import { webhooks, SignatureVerificationError } from "catzprint";

const app = express();

app.post("/webhooks/catzprint", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = webhooks.verify(req.body, req.get("CatzPrint-Signature"), process.env.CATZPRINT_WEBHOOK_SECRET!);
  } catch (err) {
    if (err instanceof SignatureVerificationError) return res.status(400).send("bad signature");
    throw err;
  }
  if (event.type === "job.failed") notifyStaff(event.data.job);
  res.sendStatus(204);
});
```

### Next.js (App Router)

```ts
// app/api/webhooks/catzprint/route.ts
import { webhooks, SignatureVerificationError, type JobWebhookEvent } from "catzprint";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const raw = await req.text();
  try {
    const event = webhooks.verify(raw, req.headers.get("catzprint-signature"), process.env.CATZPRINT_WEBHOOK_SECRET!) as JobWebhookEvent;
    if (event.type === "job.printed") await markOrderPrinted(event.data.job.reference);
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof SignatureVerificationError) return new Response("bad signature", { status: 400 });
    throw err;
  }
}
```

Events: `job.created`, `job.printed`, `job.failed`, `job.cancelled`, `job.retried`, `station.online`,
`station.offline`, `printer.status`. Each body is `{ type, created_at, org_id, data }`; job events carry
`data.job`.

To test your handler, build a valid header:

```ts
import { generateTestHeader } from "catzprint";
const header = generateTestHeader({ payload: body, secret: "whsec_test" });
```

## Examples

Runnable scripts in [`examples/`](examples) (run `npm run build` first):

- `print-receipt.mjs`: a formatted receipt from ESC/POS commands
- `print-pdf-and-wait.mjs <file.pdf>`: a sealed PDF, then `waitFor`
- `verify-webhook.mjs`: a webhook receiver on plain `node:http`

## Development

The SDK itself runs on Node.js 18+, but its dev tooling does not: the test runner (Vitest 5) needs
Node.js 22.12+ (`^22.12.0 || ^24.0.0 || >=26.0.0`) to run the tests.

```sh
npm install
npm run lint          # tsc --noEmit, strict, sources and tests
npm test              # unit tests (local fake API; PyNaCl interop if python3 + pynacl are installed)
CATZPRINT_TEST_FIXTURE=/path/to/fixture.json npm run test:integration   # against a running API
npm run build         # dist/: ESM, CJS and .d.ts
npm run vectors       # regenerate webhook vectors from the server's SignWebhook (needs Go)
```

## License

MIT © Catalizo
