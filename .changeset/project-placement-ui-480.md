---
'@kontourai/station-sdk': minor
---

Add `useProjectIdentityQuery(slug, config)` — the scoped React read for a
Project's portable identity (#480). It follows the `useProjectQuery` scope
contract (cache key carries API base, authority key and slug; a missing
scope fails closed), consuming the `project-identity` subpath through the
caller's captured request scope. Only a 404 carrying the
`project_identity_not_prepared` wire code is a verified not-prepared
Project — see `projectIdentityReadFailure` / `isProjectIdentityNotPrepared`;
a 404 without that code (older server, proxy, removed Project), denial,
transport and malformed responses stay errors and never read as absence.
`StationHttpError` now preserves the envelope's machine `code` for
status+code branching (never message-text sniffing).

`useDelegateOrchestrationTaskMutation` now takes a per-invocation
`{ input, apiBase?, requestScope? }` envelope: the captured Home address
and authority scalars travel through the transport's authority guards and
the public request body stays exactly `DelegateTaskInput` — a Home or
credential rotation across the awaits refuses instead of dispatching the
old intent under new credentials, and late hook-option changes cannot
redirect an in-flight dispatch. `delegateOrchestrationTask` accepts an
optional `ClientRequestOptions` second parameter.
