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
