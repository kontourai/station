---
'@kontourai/station-sdk': minor
---

The scheduler, skills, knowledge and secret-binding fetchers now throw
`StationHttpError` for a refused request, keeping the observed status, the
envelope's `code` (for example a station-control authority refusal such as
`station_control_caller_required`), `details` and `Retry-After`. Their thrown
message names each field of a validation refusal, as `readEnvelopeOrThrow`'s
does (`Validation failed: command Required`).

**Breaking (constructors only).** `SchedulerResponseError`,
`SchedulerRunIndeterminateError`, `SchedulerRunFailedError` and
`SchedulerRunRefusedError` now extend `StationHttpError`, and their
constructors take the `StationHttpError` the client built from the response
in place of a status and message:

- `new SchedulerResponseError(status, message, detail)` becomes
  `new SchedulerResponseError(new StationHttpError(status, message), detail)`.
- `new SchedulerRunFailedError(message, receipt)` (and the refused and
  indeterminate forms) becomes
  `new SchedulerRunFailedError(new StationHttpError(status, message), receipt)`.

Code that only catches these errors is unaffected, and a run error's `code`
is still its own fixed value. The SDK throws these errors itself; nothing in
Station constructs them outside the SDK.

`PluginCollectionHttpError` now extends `StationHttpError`. Its constructor
keeps `(status, envelope)` and gains an optional third argument,
`{ retryAfterMs, details }`. It carries the envelope's `code` on the error and
on `envelope.code`, and keeps a refusal's `Retry-After` and `details`.

The skills and secret-binding fetchers keep the status of a failure whose body
is not JSON (a proxy's HTML 502) instead of throwing a bare `SyntaxError`.

New `createLocalSkill` and `updateLocalSkill` fetchers back
`useCreateLocalSkillMutation` and `useUpdateLocalSkillMutation`, which still
resolve to the whole envelope.
