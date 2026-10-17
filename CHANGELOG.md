# Changelog

All notable changes to `catzprint` are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## 2.1.3 - 2026-10-17

The package is now published as `catzprint` (`npm i catzprint`, `import { CatzPrint } from "catzprint"`), replacing the older 1.x package of the same name.

### Security

- The base URL must use `https://`; `http://` is accepted only for `localhost`, `127.0.0.1`, `[::1]` and
  `*.localhost`, so the API key is never sent in clear text.
- Redirects are never followed (`redirect: "manual"`), so the `Authorization` header only reaches the configured
  host; a 3xx answer raises an `unexpected_redirect` error.
- Response bodies are capped at 64 MiB; a larger answer is an error instead of being buffered.
- Webhook verification hardened: an empty secret is rejected and a non-numeric `tolerance` (e.g. `NaN`) no
  longer disables the timestamp check.
- `WebhookEvent.id`: the delivery id the server now includes in every signed event. Deduplicate on `event.id`;
  the timestamp check limits the replay window to 5 minutes, it does not stop replays within it.
- Poly1305's final reduction and tag addition now run on fixed-size limbs instead of BigInt; the README's
  constant-time wording is now explicitly best-effort.
- The prebuilt `dist/` and `catzprint-sdk-2.1.3.tgz` were rebuilt so they contain these fixes.

## 1.0.0 - 2026-10-16

First release.

- `CatzPrint` client: API key from options or `CATZPRINT_API_KEY`, base URL from options or
  `CATZPRINT_BASE_URL`, organization looked up from `GET /v1/key` and cached; `key()` / `whoami()`.
- Jobs: `create`, `get`, `list`, `iterate` (auto-pagination), `cancel`, `retry`, `reprint`, `waitFor`.
- Print helpers: `printText`, `printPdf`, `printImage`, `printReceipt`, `printTemplate`.
- Printers, locations (`list`, `get`) and templates (`list`).
- Sealed printing (`sealed: true`): NaCl `crypto_box_seal` to the server key, with no runtime
  dependency; verified against libsodium.
- Webhooks: `verify` / `constructEvent`, `verifySignature`, `generateTestHeader`; constant-time
  comparison, multiple `v1` signatures, 300 s default tolerance.
- Typed errors (`AuthenticationError`, `PermissionError`, `NotFoundError`, `ValidationError`,
  `OutOfPrintsError`, `ConflictError`, `RateLimitError`, `ServerError`, `ConnectionError`,
  `TimeoutError`, `SignatureVerificationError`).
- Retries with exponential backoff and jitter on network errors, 429 (honouring Retry-After) and
  502/503/504; POSTs are retried only with an idempotency key, which `jobs.create` always sends.
- Dual ESM + CommonJS build with TypeScript declarations; Node 18+.
