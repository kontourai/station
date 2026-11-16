---
"@kontourai/station-connect": patch
---

`ConnectionStore` reads saved connections one row at a time: a row this build cannot read is left out of the list and written back unchanged instead of emptying it, and the new `hasUnreadableStoredList()` lets a host skip Default seeding and legacy migration over a stored value it cannot parse. A pairing flight stopped after its journal claim and before sending now releases the claim and reports `aborted`, and an `indeterminate` outcome after a failed local save carries the save's `failure`.
