---
'@kontourai/station-sdk': minor
'@kontourai/station-contracts': minor
---

Add `useProjectIdentityQuery(slug, config)` — the scoped React read for a
Project's portable identity (#480). It follows the `useProjectQuery` scope
contract (cache key carries API base, authority key and slug; a missing
scope fails closed), consuming the `project-identity` subpath through the
caller's captured request scope. Callers that know the selected local
Project record can pass `expectedProjectId`: it joins the cache key and
validates the response's `association.localProjectId`, so a same-slug
delete/recreate or stale server answer never delivers the previous
incarnation's portable identity as success (typed
`ProjectIdentityIncarnationMismatchError`, recoverable by refetch).
Only a 404 carrying the
`project_identity_not_prepared` wire code is a verified not-prepared
Project — see `projectIdentityReadFailure` / `isProjectIdentityNotPrepared`;
a 404 without that code (older server, proxy, removed Project), denial,
transport and malformed responses stay errors and never read as absence.
`StationHttpError` now preserves the envelope's machine `code` for
status+code branching (never message-text sniffing).

`useDelegateOrchestrationTaskMutation` keeps its published call shape — a
plain `DelegateTaskInput` resolved against the hook's `apiBase` default and
ambient authority, unchanged for existing consumers — and additionally
accepts a per-invocation `{ input, apiBase?, requestScope? }` envelope: the
captured Home address and authority scalars travel through the transport's
authority guards and the public request body stays exactly
`DelegateTaskInput` — a Home or credential rotation across the awaits
refuses instead of dispatching the old intent under new credentials, and
late hook-option changes cannot redirect an in-flight dispatch.
`delegateOrchestrationTask` accepts an optional `ClientRequestOptions`
second parameter.

Scope note (#480): the supported Project-placement path is the portable
DELEGATION intent (`project-portable`) dispatched by the delegation
launcher, where the receiving Station verifies the offer on submit. The
FOREGROUND thread-execution path has no portable identity or receiver
admission in this slice: a non-portable Project workspace resolved onto a
paired Station is refused (`receiver_execution_not_offered`, zero remote
effect) rather than silently run as an unrelated same-slug Project, and
the thread-default environment picker no longer offers new paired
Station selections while preserving an already-saved paired default.
Full portable foreground identity/admission remains the next #480/#484
slice.
