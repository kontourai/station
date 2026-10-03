---
"@kontourai/station-contracts": patch
---

Reject malformed date/time template format options before configuration reaches
prompt substitution. Settings, online/offline config writes, and persisted
configuration reads use the same validation semantics.
