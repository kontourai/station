---
'@kontourai/station-sdk': minor
---

The conversation and orchestration fetchers now throw `StationHttpError` for
every refused request, keeping the observed status, the envelope's `code`
(for example a station-control authority refusal), `details` and
`Retry-After`, with a field-qualified message for a validation refusal. A
`200` answer carrying `{ success: false }` used to throw a plain `Error`; it
now throws a `StationHttpError` whose status is `200`, the same rule as
`readEnvelopeOrThrow`. A body that is not JSON still keeps its status on a
non-2xx and is still a plain `Error` on a 2xx. `respondToRequest`'s error
still carries the failure `receipt`.
