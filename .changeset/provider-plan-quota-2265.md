---
'@kontourai/station-sdk': patch
'@kontourai/station-cli': patch
---

Surface classified provider-plan quota failures in delegate status and
events (#2265). `DelegatedTaskReason`/`DelegatedTaskEvent` carry the
serving Station's re-validated bounded facts (plan window,
provider-reported timezone-less reset text, qualified retry-after only
when genuinely supplied); `station delegate status` (and `wait`'s summary)
renders them beneath the fixed guidance line. No retry, model/provider
switch, or paid fallback is added — the task stays failed and resumable.
