---
'@kontourai/station-contracts': patch
'@kontourai/station-sdk': patch
---

A child-work settle now replaces usage that is still the child's last
running-time figure. When the first terminal settle carries no usage (Claude
Code's `task_updated`), the child keeps its last progress figure, marked
`usageProvisional: true`, and the later settle that reports usage (its
`task_notification`) replaces it. Usage a settle reported stays sticky against
stale duplicates, and identity and result remain fill-only.
