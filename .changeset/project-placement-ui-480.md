---
'@kontourai/station-sdk': minor
---

Add `useProjectIdentityQuery(slug, config)` — the scoped React read for a
Project's portable identity (#480). It follows the `useProjectQuery` scope
contract (cache key carries API base, authority key and slug; a missing
scope fails closed), consuming the `project-identity` subpath through the
caller's captured request scope. Only a 404 read is a verified not-prepared
Project; denial, transport and malformed responses stay errors and never
read as absence.
