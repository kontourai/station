---
'@kontourai/station-sdk': minor
---

The scheduler, skills, knowledge and secret-binding fetchers now throw
`StationHttpError` for a refused request, keeping the observed status, the
envelope's `code` (for example a station-control authority refusal such as
`station_control_caller_required`), `details` and `Retry-After`. Their thrown
message names each field of a validation refusal, as `readEnvelopeOrThrow`'s
does (`Validation failed: command Required`).

`SchedulerResponseError`, `SchedulerRunIndeterminateError`,
`SchedulerRunFailedError` and `SchedulerRunRefusedError` extend
`StationHttpError`, and their constructors now take the `StationHttpError`
the client built from the response in place of a message. A run error's
`code` is still its own fixed value. `PluginCollectionHttpError` extends
`StationHttpError` and carries the envelope's `code`, on the error and on
`envelope.code`.

New `createLocalSkill` and `updateLocalSkill` fetchers back
`useCreateLocalSkillMutation` and `useUpdateLocalSkillMutation`, which still
resolve to the whole envelope.
