---
"@kontourai/station-cli": patch
---

`station plugins list`, `preview`, `install`, `update`, `remove` and
`registry install` report a request that hit its deadline as a timeout
instead of claiming Station is not reachable. A timed-out install or update
now says the write may still have been applied, rather than inviting a
blind retry. A refused connection is still reported as unreachable.
