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

A thrown `StationHttpError`'s message names each field of a validation
refusal — `Validation failed: command Required, name Required` — matching the
CLI. New `envelopeReasons(details)` and `envelopeDetailsMessage(details)` on
`@kontourai/station-sdk/client` return, respectively, the reason sentences
for display (no field keys, each once) and the field-qualified part the CLI
prints. `apiErrorMessage` returns the reason sentences alone, now deduplicated, and
`envelopeErrorMessage`, which ignored `details` before, now does the same.
`envelopeErrorCode`, and so every Project fetcher's `StationHttpError.code`,
now falls back to the object `error`'s own `code`: a runtime 401 or 403 now
carries `authentication_required` or `insufficient_scope` where it used to
carry no code. `envelopeFailureMessage` is deprecated in favour of
`envelopeError` and `apiErrorMessage`.
