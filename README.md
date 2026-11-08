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
| `PrinterError` | a station's printer is offline, out of paper, open or in error (503) |
| `StationUnreachableError` | no station could be reached (`code` `station_unreachable`, `urls`, `attempts`, `cloudError`) |
| `OutcomeUnknownError` | a job was sent but the answer was lost and couldn't be confirmed (`code` `outcome_unknown`); retry later with the same key |

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

## Local printing (offline)

A restaurant must print when its internet is down. With the `local` option, the SDK sends jobs straight
to the CatzPrint Station (desktop or Android) on the same network (its local API on port 7443). The station reports
everything it printed offline to the cloud when it's back: one job per idempotency key, billed, with
webhooks (`printed_locally`, `offline`, `duplicate_of`).

```ts
import { CatzPrint, FileTokenStore, isPrinterOffline, isOutOfPaper, StationUnreachableError } from "catzprint";

const cz = new CatzPrint({
  apiKey: process.env.CATZPRINT_API_KEY,
  local: {
    mode: "local_first",
    locationId,
    discover: true, // the cloud's endpoint list + mDNS on the LAN
    tokenStore: new FileTokenStore("/var/lib/catzserve/catzprint-local.json"),
    deviceName: "CatzServe hub",
  },
});

// A kitchen ticket with an inverted ALLERGY banner
const job = await cz.jobs.create({
  role: "kitchen",
  reference: `order-${order.id}`,
  // One key per ticket and attempt: the station and the cloud both dedupe on it,
  // so a fallback or a retry never prints twice.
  idempotencyKey: `order-${order.id}-kitchen-r1`,
  commands: [
    { type: "text", text: " ALLERGY: PEANUTS ", align: "center", bold: true, invert: true, size: 2 },
    { type: "text", text: "Table 12", bold: true, size: 2 },
    { type: "line" },
    { type: "columns", columns: [{ text: "2 x", width: 0.15 }, { text: "Pad thai", bold: true }] },
    { type: "cut" },
  ],
});

// Or a saved template with data (templates are synced to the station):
await cz.jobs.create({ role: "kitchen", templateId, data: { table: "12", items }, idempotencyKey: `order-${order.id}-kitchen-r1` });

console.log(job.id, job.status, job.via); // lj_… queued local   (or … cloud)
await cz.close(); // on shutdown: stops background refreshes
```

### Modes

| `mode` | Behaviour |
|---|---|
| `"cloud"` (default) | Unchanged: every job goes to the API. |
| `"local"` | Stations only; none reachable → `StationUnreachableError`. |
| `"local_first"` | Stations first; the cloud **only** when no station can be reached. |
| `"cloud_first"` | Cloud first; stations on a network error, timeout or 5xx. A 4xx is thrown, not retried locally. |

`local_first` falls back only when stations are **unreachable**: connection/TLS/timeout errors, `502`/`504`,
and `503 local_disabled`. A station that answers is never second-guessed; these are thrown, never sent to
the cloud: `503 printer_offline` / `out_of_paper` / `cover_open` / `printer_error` (`PrinterError`,
`isPrinterOffline`, `isOutOfPaper`, `isCoverOpen`; the job was not accepted), `422 no_printer` / `invalid`
(`ValidationError`), `402 offline_allowance_exhausted` (`OutOfPrintsError`, `isOfflineAllowanceExhausted`),
`403 device_not_approved` (`PermissionError`). On a `401 token_expired` the SDK mints a fresh token once and retries
(at most once per 10 minutes); on any other `401` (`device_revoked`, `unauthenticated`), or when it can't renew,
`local_first` uses the cloud and `local` throws the `AuthenticationError`.

**Never printed twice.** The SDK tells "the job never got there" from "it got there but the answer was lost":

- *Not delivered* (DNS, connect, TLS or pin failure, or the station refused with 502/504/503
  `local_disabled`): the next station is tried, then (in `local_first`) the cloud.
- *Sent, no answer* (timeout or reset after the request was written, a body error, an answer over 4 MiB or
  unreadable, a redirect): the SDK asks **that station** for the job by idempotency key (up to 3 times
  within 5 s). Found → that job. 404 → it never got it, move on. Still unknown → `OutcomeUnknownError`
  (`code` `"outcome_unknown"`, `url`, `idempotencyKey`, `isOutcomeUnknown(err)`) and **no fallback**.
- The cloud leg (`cloud_first`, and the cloud fallback of `local_first`) makes one attempt. Not delivered or
  502/503/504 → `cloud_first` goes to the stations, `local_first` throws `StationUnreachableError` with
  `cloudError`. Sent with no answer or a 500 → one retry with the same key; ambiguous or undelivered again →
  `OutcomeUnknownError`, never a station. With your own `fetch`, "not delivered" is recognized only from
  connection-refused/DNS/TLS error codes.

- A probe answered with `409 duplicate` (the key belongs to a job this device can't see) is thrown as that
  `ConflictError`: an answer, no fallback. Only `404 not_found` means "never recorded". A `409 in_progress` (on
  the job request or a probe) is waited for by probing; if it never settles → `OutcomeUnknownError`. After the
  job request itself, or an earlier probe, was answered `409 in_progress`, a probe's `404` is **not** "never
  recorded" either → `OutcomeUnknownError` (no next station, no cloud).
- The cloud request is built (and sealed) once; the ambiguous retry and the 409 re-sends send the same bytes.
  Jobs that can't print locally (PDF, images, documents, sealed, scheduled) use the cloud-mode create, 409 loop
  included, in every mode. A failure before the job request (org lookup, server-key fetch) is not delivered.
- A cloud `409 duplicate` / "being created" is re-sent identically up to 3 times, 1 s apart (in every mode;
  in cloud mode the generated key is fixed before the first send); still 409 → that conflict is thrown. A
  re-send that isn't delivered or is ambiguous → `OutcomeUnknownError`.
- A cloud `400`/`422` naming `sealed_content` (the server key was rotated) drops the cached server key, fetches
  it again, re-seals and re-sends **once** with the same idempotency key. After an ambiguous attempt, a failed
  key fetch or a re-send that is again rejected, not delivered or ambiguous → `OutcomeUnknownError` (never a
  `ValidationError`, never local); without one, a repeated rejection is thrown as the `ValidationError`. The
  server key is cached for at most an hour.
- In `local_first`, a cloud 4xx (or `OutcomeUnknownError`) after the stations were unreachable is thrown as
  is, not wrapped in `StationUnreachableError`.
- **Aborting** `signal` after the job request was fully written throws `OutcomeUnknownError` with the abort
  reason as `cause` (the job may print; no fallback); aborting before that throws the abort reason.
- Browser (`catzprint/local`): a network error on a print counts as "maybe delivered" when that station
  answered in the last 30 s, or answers `GET /local/v1/info` right after the error; the SDK then asks it by
  key. Every station whose print failed that way gets at least one `/info` try of at most 1 s. Only a station
  that has answered at least once in this client's lifetime is asked again, until it answers or the `print()`'s
  ~5 s budget (time actually spent on `/info`, shared by all stations) is used up. A station that doesn't
  answer counts as not delivered.

Retrying later with the same idempotency key is always safe.

The fallback modes always send an idempotency key (`sdk-<uuid v4>` when you don't pass one or it is blank; keys
with surrounding whitespace or control characters are refused), the **same**
one to the station and the cloud. PDFs, images, documents, sealed and scheduled jobs go straight to the
cloud in `local_first`/`cloud_first` and throw `unsupported_locally` in `local` mode. When a job has
neither `printerId` nor `locationId`, `local.locationId` is used. Pass `signal` to `jobs.create` to cancel;
a cancelled create never falls back.

```ts
try {
  await cz.jobs.create(ticket);
} catch (err) {
  if (isPrinterOffline(err) || isOutOfPaper(err)) alertStaff(err.message); // retry later with the same key
  else if (err instanceof StationUnreachableError) console.error(err.urls, err.cloudError);
  else throw err;
}
```

### Finding and trusting stations

Order: `stations`, then (with `discover`) the cloud endpoint list's URLs (public hostnames before raw
IPs), then current addresses found over mDNS (`_catzprint._tcp`, via `node:dgram`), browsed only if the
others failed.

- **Public hostnames** (`https://192-168-1-20.<label>.local.catzprint.com:7443`) come **only** from the
  cloud endpoint list. They are verified normally **and** the certificate's public key must match the
  list's `public_spki_sha256`. The SDK connects to the IP in the name (so they work while public DNS is
  down) only under that station's own label.
- **IP URLs** are trusted **only** with a pinned SHA-256 fingerprint of the station's self-signed
  certificate, from the cloud endpoint list or `local.fingerprints` (the station app shows it), checked
  before a single request byte is sent. Only private addresses are used; nothing is trusted on first use.
- **mDNS is never trusted on its own**: it maps a station ID to its current address only for stations on
  the cloud list (pinned with the list's fingerprint) or whose fingerprint is in `fingerprints`. The
  announced hostname is ignored.

The local token (`czl1…`) is minted with your API key (`POST /v1/orgs/{org}/local-tokens`, scope
`jobs:write`) and **bound to `locationId`** (required unless `allLocations: true`), cached in the
`tokenStore` with the endpoint list, renewed in the background when less than 7 days are left; the
endpoint list is refreshed hourly while online. A station's `401 token_expired` causes one fresh mint
and a retry, at most once per 10 minutes per device; `401 device_revoked` is never answered with a new
token. `FileTokenStore` writes mode 0600 through an atomic rename and refuses (`InsecureTokenStoreError`) a file or
directory not owned by you or writable by group/others (POSIX); tokens are renewed when less than min(7 days,
half their lifetime) is left; the default `MemoryTokenStore` forgets
on restart. Custom stores implement `{ load(key), save(key, token) }`.

Options: `connectTimeoutMs` (3000), `requestTimeoutMs` (15000), `cloudTimeoutMs` (10000: the cloud attempt
in `cloud_first`, minting, refreshes), `discoverTimeoutMs` (1500), `waitSeconds` (0..30: the station answers
once the job printed or failed), `token` (a fixed `czd_…`/`czl1.…` token), `tokenTtlDays`, `ca`.

### Local helpers

```ts
await cz.local.status();                  // printers, paper, unsynced jobs, offline allowance
await cz.local.discover();                // endpoint list + mDNS, merged by station
await cz.local.info(url);                 // GET /local/v1/info
await cz.jobs.get("lj_…");                // local job IDs are read from the station (waitFor works too)
await cz.local.refresh();                 // renew token / endpoint list now
const token = await cz.local.token();     // the czl1 token, e.g. for a browser POS
// Pairing needs the fingerprint shown in the station app (or a station on the cloud list):
const { token: deviceToken } = await cz.local.pair("https://192.168.1.20:7443", "12345678", "Till 3", { fingerprint: "3f1a…" });

// A paired till needs no API key (local mode + its device token); its cloud calls throw missing_api_key.
const till = new CatzPrint({ local: { mode: "local", stations: ["https://192.168.1.20:7443"], fingerprints: { "192.168.1.20": "3f1a…" }, token: deviceToken } });

const lt = await cz.localTokens.create({ deviceName: "Till 3", locationIds: [locationId], ttlDays: 30 });
await cz.localTokens.revoke(lt.token_id);
await cz.localEndpoints.list({ locationId });
```

### In the browser: `catzprint/local`

A zero-dependency ESM entry (fetch + WebCrypto, no Node built-ins) for a browser POS. Browsers only
accept stations whose certificate they trust, so use the public hostnames, and add your POS origin to the
organization's **local allowed origins**. Mint the token on your backend (`cz.local.token()` or
`localTokens.create`) or pair the browser with a station.

```ts
import { CatzPrintLocal, isPrinterOffline } from "catzprint/local";

const local = new CatzPrintLocal({
  stations: ["https://192-168-1-20.ab3k9x2mqp.local.catzprint.com:7443"],
  token,                                              // czl1… from your backend, or czd_… from pair()
  refreshToken: () => api.get("/catzprint/token"),    // optional: called once on 401 token_expired
  fallback: (params, error) => api.post("/print", params), // optional: no station → your backend/cloud, same idempotencyKey
});

const job = await local.print({ role: "kitchen", templateId, data, idempotencyKey: `order-${id}-kitchen-r1` });
await local.getJob(job.id);
await local.status();
const { token: deviceToken } = await local.pair(url, "12345678", "Till 3");
```

`fallback` is only called when no station is reachable (or the token is refused); printer errors,
validation errors and `402` are thrown. A request that times out may have reached the station: the SDK then
asks it by idempotency key and, if that stays unknown, throws `OutcomeUnknownError` instead of calling
`fallback`. Answers are capped at 4 MiB. Browsers don't say whether a failed fetch was sent: after a
network error on a print, the SDK checks whether the station is reachable (it answered in the last 30 s, or
`GET /local/v1/info` answers: always one try of at most 1 s; more tries, within a ~5 s per-`print()` budget
of `/info` time, only for a station that has answered before). If it is, the job may have arrived and the
SDK asks for it by key (found → that job, `not_found` → next station, otherwise `OutcomeUnknownError`); only
when the station stays unreachable does it count as "not delivered". A `409 in_progress` (the station is still
processing that key) is waited for the same way, and a `not_found` after an `in_progress` answer is
`OutcomeUnknownError`. `pair()` and `localTokens.create()` results include `token`
in JSON (so a backend can hand it to a till) but show it redacted in `console.log` / `util.inspect` /
`String(result)`. Error classes from `catzprint/local` are separate copies of those in
`catzprint`; compare by `err.code` (or `isPrinterOffline` & co.) when mixing both entries.

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
- `local-hub.mjs`: a restaurant hub printing kitchen tickets offline (`local_first`)

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
