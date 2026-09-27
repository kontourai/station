---
'@kontourai/station-sdk': minor
---

The Project fetchers (everything built on `unwrapProjectResponse`) and the
plugin fetchers (`listPlugins`, `previewPluginRecovery`, `recoverPlugin`) now
throw the envelope helper's `StationHttpError` for a refused request, keeping
the observed status, `code`, `details` and `Retry-After`, with a message that
names each field of a validation refusal
(`Validation failed: name String must contain at least 1 character(s)`). A
`200` carrying `{ success: false }` now throws a `StationHttpError` whose
status is `200` instead of a plain `Error`; a body that is not JSON keeps its
status on a non-2xx and is still a plain `Error` on a 2xx.

**Breaking (constructor only).** `PluginCollectionHttpError`'s constructor now
takes the `StationHttpError` the client built from the response, and an
optional `{ grantsUnavailable }`, in place of `(status, envelope, options)`:
`new PluginCollectionHttpError(new StationHttpError(status, message, { code }))`.
Its `envelope` is derived from that error. A `429` collection read now carries
`retryAfterMs`. Code that only catches the error is unaffected.
