---
'@kontourai/station-sdk': minor
---

`StationHttpError` gains `details`, the refused envelope's `details` as sent.
`readEnvelopeOrThrow` now throws `StationHttpError` for a refused envelope,
carrying the observed status (a `200` with `success: false` too), the
envelope's `code` (top-level, else the object `error`'s own), `details` and
`Retry-After`, instead of a plain `Error`. `apiErrorMessage`,
`envelopeErrorMessage` and `readEnvelopeOrThrow` share one message rule:
validation details, a string `error`, the object `error`'s `message` then
`code`, the top-level `message`, then the fallback. An object `error` now
reads as its message or code rather than as serialized JSON.

Validation refusals now name each field — `Validation failed: command
Required, name Required` rather than the bare sentences — matching the CLI.
`envelopeErrorCode`, and so every Project fetcher's `StationHttpError.code`,
now falls back to the object `error`'s own `code`: a runtime 401 or 403 now
carries `authentication_required` or `insufficient_scope` where it used to
carry no code. `envelopeFailureMessage` is deprecated in favour of
`envelopeError` and `apiErrorMessage`.
