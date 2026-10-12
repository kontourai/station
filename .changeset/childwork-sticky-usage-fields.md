---
'@kontourai/station-contracts': minor
'@kontourai/station-sdk': minor
---

A child-work usage field that a settle reported now stays sticky even while
other fields are still running-time figures (#3337). The reducer records the
still-running fields on a provisional item as the new optional
`ChildWorkItem.usageRunningFields` (absent while provisional means every field
is running), and `childWorkSettleFromItem` carries it on the settle delta, so a
replay keeps the split. A stale duration-only settle no longer overwrites the
duration an earlier settle reported.
