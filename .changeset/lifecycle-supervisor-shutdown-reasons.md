---
"@kontourai/station-shared": minor
---

The lifecycle journal accepts the `stdout_epipe`, `supervisor_drain`, and `supervisor_disconnect` shutdown reasons, exported with the others as `LIFECYCLE_SHUTDOWN_REASONS`, instead of rejecting the event, and `classifyLifecycleExit` reports the two supervisor reasons as `supervisor_drain` and `supervisor_disconnect` rather than a crash.
