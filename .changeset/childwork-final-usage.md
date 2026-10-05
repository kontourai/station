---
'@kontourai/station-contracts': minor
'@kontourai/station-sdk': minor
---

A child-work settle now replaces usage that is still the child's last
running-time figure. When the first terminal settle carries no usage (Claude
Code's `task_updated`), the child keeps its last progress figure, marked with
the new optional `ChildWorkItem.usageProvisional: true`, and the later settle
that reports usage (its `task_notification`) replaces it. The flag stays until
every field of the running figure has been replaced, so a duration-only settle
does not make a running token count final. Usage a settle reported stays sticky
against stale duplicates, and identity and result remain fill-only. A settle
delta can carry `usageProvisional: true` to restate a running figure, and the
new `childWorkSettleFromItem` turns a stored settled item back into such a
settle, so history seeding and reconnect snapshots keep the flag.
