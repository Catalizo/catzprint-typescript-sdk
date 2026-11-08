# Changelog

All notable changes to `catzprint` are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## 2.2.1 - 2026-11-07

Security audit round 7 (no API changes).

- A cloud `400`/`422` naming `sealed_content` (the server key was rotated) is no longer final: the SDK drops the cached server key, fetches it again, re-seals and re-sends **once** with the same idempotency key. After an ambiguous attempt (an answer lost, a retry in flight, a `409 duplicate`), a failed key fetch, or a re-send that is rejected again, not delivered or ambiguous, is `OutcomeUnknown` — never a validation error, never local. Without one, a repeated rejection is returned as the validation error.
- The server key is cached for at most an hour (and dropped at once on a `sealed_content` rejection).
- A station that answered the job request `409 in_progress` and then `404 not_found` to the probe by key is `OutcomeUnknown` (no next station, no cloud): the 404 only means "never recorded" when the request itself wasn't answered `in_progress`. Also in the browser entry (`catzprint/local`).
- Stored token placeholders are recognised by the same set in every SDK: `…`, a run of 3+ `*`, `[redacted]`, `redacted`, `hidden` (any case), optionally after `czl1.` or `czd_`. `local.storeError` is cleared once a fresh token was minted and stored.
- Once any answer for the key said `409 in_progress` (the job request or a probe by key), a later probe `404 not_found` is `OutcomeUnknown` (no next station, no cloud). Also in the browser entry.
- Browser entry: after a network error on a print, a station always gets at least one `GET /local/v1/info` try of
  at most 1 s. Extra tries (until it answers) are only for a station that has answered at least once in this
  client's lifetime, within one ~5 s budget per `print()` shared by all stations that counts only time spent on
  `/info` (was: up to 5 s per station; an intermediate 2.2.1 build measured the budget in wall-clock time, so a
  slow first station could make a station that had taken the job be skipped and printed again by `fallback`).
- After a `401 token_expired` and a re-mint, the re-sent job request's answer gets the same handling as any other (a `409 in_progress` or a `2xx` without a job → ask the station by key), like the other SDKs.
- Browser entry: any HTTP answer from a station (not only a `2xx`) counts as "answered recently" for the network-error check.
- The prebuilt `dist/` was rebuilt.

## 2.2.0 - 2026-11-07

Local printing: print through the CatzPrint desktop station on the same network when the internet is down.

- `new CatzPrint({ local: { mode, locationId, stations, fingerprints, discover, tokenStore, token, deviceName, … } })`
  with modes `cloud` (default, unchanged), `local`, `local_first` and `cloud_first`. `local_first` falls back to
  the cloud only when no station can be reached (connect/TLS/timeout, 502/504, 503 `local_disabled`);
  `cloud_first` falls back to the stations on a network error, timeout or 5xx. Printer errors, `no_printer`,
  validation errors and `402 offline_allowance_exhausted` are always thrown.
- Fallback modes always send an idempotency key (`sdk-<uuid v4>` by default), the same one to the station and
  the cloud. `jobs.create` accepts `signal`.
- Local tokens minted, cached in a `TokenStore` (`FileTokenStore`: mode 0600, atomic writes; `MemoryTokenStore`),
  renewed when less than 7 days are left and re-minted once on a 401; the endpoint list is cached and refreshed
  hourly while online.
- Discovery: configured stations, the cloud endpoint list, and mDNS (`node:dgram`).
- TLS: public hostnames verified normally (and reached without DNS); IP and self-signed stations only with a
  pinned SHA-256 fingerprint, checked in a custom `https.Agent` before any request byte is sent. Never
  trust-on-first-use; mDNS stations missing from a known endpoint list are ignored.
- `cz.local` (`status`, `discover`, `info`, `pair`, `getJob`, `refresh`, `token`, `close`), `cz.localTokens`
  (`create`, `revoke`), `cz.localEndpoints.list`, `cz.close()`. `jobs.get`/`waitFor` read `lj_…` IDs from the
  station.
- `Job` gains `printed_locally`, `local_device`, `duplicate_of`, `offline`, `idempotency_key`, and SDK-set
  `via` / `local`.
- Errors: `StationUnreachableError` (`code` `station_unreachable`), `PrinterError`, `PinMismatchError`,
  `NoPinError`; helpers `isPrinterOffline`, `isOutOfPaper`, `isCoverOpen`, `isOfflineAllowanceExhausted`,
  `isStationUnreachable`. API errors with a `param` fill `fields`.
- New browser entry `catzprint/local` (ESM, fetch + WebCrypto only): `CatzPrintLocal` with `pair`, `print`,
  `getJob`, `findJob`, `status`, `info`, and `fallback` / `refreshToken` hooks.
- New example `examples/local-hub.mjs`. No new dependencies.

Security hardening before release (review findings H4, M6, M7, M8; spec addendum A10–A12, A15):

- Public hostnames come only from the cloud endpoint list (never mDNS) and, besides normal verification,
  the certificate's public key must match `public_spki_sha256`. Direct connection to the IP in a
  `a-b-c-d.<label>.<zone>` name only under that station's own label.
- mDNS only maps a station ID to its address for stations on the cloud list or with a configured
  fingerprint; never trusted alone. Public IPs from the list or mDNS are ignored.
- Minted tokens are bound to `local.locationId`, now required unless `allLocations: true` (or a fixed `token`).
- Re-mint only on `401 token_expired`, at most once per 10 minutes per store key (`last_remint_at`); never on
  `device_revoked`. In `catzprint/local`, `refreshToken` is likewise only called for `token_expired`.
- `local.pair(url, code, deviceName, { fingerprint })` requires the fingerprint from the station app (or the
  station on the cloud endpoint list).
- `LocalJob.live` maps to `Job.live`; paired-device jobs are live.
- `new CatzPrint({ local: { mode: "local", token } })` works without an API key; cloud calls throw
  `missing_api_key`.
- `LocalEndpoint` gains `public_spki_sha256`, `local_label`; `PinMismatchError.spki`; `LocalStation.hostname` removed.

Audit round 4 (SDK addendum 2):

- SDK-1: never double-print on an ambiguous outcome. Station requests are classified as not delivered or
  sent-without-answer (tracked with the request's `finish` event); a lost answer is checked on the same station
  by idempotency key (3 tries within 5 s); unresolved → `OutcomeUnknownError` (`code` `outcome_unknown`,
  `isOutcomeUnknown`) and no fallback. The cloud leg of the fallback modes makes one attempt (on `node:http(s)`,
  so delivery is known) and one retry with the same key after an ambiguous answer or a 500; ambiguous twice →
  `OutcomeUnknownError`, never a station. The browser entry probes after a timeout too.
- SDK-2: a blank `idempotencyKey` counts as none; padded keys or control characters throw `ValidationError`
  (also in `catzprint/local`).
- SDK-3: sealing (and the server key check) refuses small-order X25519 keys.
- SDK-4: `cz.local` and `CatzPrintLocal` have redacting `toJSON` / inspect; `localTokens.create()` and `pair()`
  results keep `token` non-enumerable (still `result.token`).
- SDK-5: a station answer over 4 MiB is `response_too_large` and never sent elsewhere (probe for jobs, then
  `OutcomeUnknownError`); the browser entry caps bodies at 4 MiB.
- SDK-6: tokens are renewed when less than min(7 days, TTL/2) is left (`issued_at`).
- SDK-8: `FileTokenStore` refuses (`InsecureTokenStoreError`) a file or directory not owned by the current user
  or group/world-writable (POSIX).
- SDK-9: `dashedIp` rejects leading-zero octets.

Audit round 5 (SDK addendum 3):

- R1: an `OutcomeUnknownError` from the cloud leg is never "not delivered"; `local_first` throws it as is.
- R2 (`catzprint/local`): a network error on a print counts as maybe delivered when the station answered in
  the last 30 s or answers `GET /local/v1/info` within 1 s; the SDK then probes by key.
- R3: a probe answered `409 duplicate` throws that `ConflictError` (no fallback); only `404 not_found` means
  "never recorded" (Node and browser).
- R4: a cloud `409 duplicate`/"being created" is re-sent identically up to 3 times, 1 s apart (every mode; cloud
  mode fixes the generated key before the first send); still 409 → that conflict; a re-send not delivered or
  ambiguous → `OutcomeUnknownError`.
- C1–C6: a cloud 4xx in `local_first` is thrown unwrapped; any 5xx but 502/503/504 is ambiguous; an org-ID
  lookup failure counts as not delivered; the token store owner check uses `process.geteuid()`; a 2xx without a
  usable job is ambiguous (probe / retry); aborting after the request was written → `OutcomeUnknownError`
  wrapping the reason.

Audit round 6 (SDK addendum 4):

- Q1: a station `409 in_progress` (job request or probe) is waited for by probing; never a fallback; unresolved →
  `OutcomeUnknownError` (Node and browser).
- Q2: `localTokens.create()` and `pair()` results serialize **with** `token` again (`JSON.stringify`, `res.json`),
  so backends can hand tokens to browser tills; `util.inspect` / `console.log` / `String(result)` show it redacted.
  A stored token that is a redaction placeholder counts as "no token" (`local.storeError`).
- Q3: the cloud request is built and sealed once per create (`jobs.prepareCloud` / `jobs.postCloud`); retries and
  409 re-sends send the same body.
- Q4: jobs that can't print locally use the cloud-mode create (`jobs.createCloudMode`, 409 loop included) in the
  fallback modes.
- Q5 (`catzprint/local`): after a network error on a print, `GET /local/v1/info` is retried within the 5 s probe
  budget before the station counts as not reached.
- Q6: a failed server-key fetch for sealing is not delivered.
- A race where an oversized answer could look like a lost connection is fixed.

## 2.1.4 - 2026-10-20

- Docs only: the README explains that printer names aren't unique across stations, how to target printers by ID, and the console's copy-ID shortcut.

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
