---
'@kontourai/station-contracts': minor
---

The workspace Home projection names one more field,
`delegationEnvironmentKind`: whether a work item is this Station's record of a
delegated task running on a paired Station. Home uses it to open such an item
in Activity rather than as a local chat. Because the projection widened, an
existing Home role grant no longer covers it, and Home shows its fallback
until the grant is approved again.
