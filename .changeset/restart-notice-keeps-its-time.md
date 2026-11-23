---
"@kontourai/station-shared": patch
---

`projectRuntimeEventsToMessages` stamps the interrupted-turn notice with its
event's time when the notice closes a turn that was still open (a turn that
ended in `runtime.error`). The notice had no `metadata.timestamp` in that case,
so readers that order rows by time placed it after every later turn.
