---
"@kontourai/station-shared": patch
---

The lifecycle journal accepts the `stdout_epipe`, `supervisor_drain`, and `supervisor_disconnect` shutdown reasons, exported with the others as `LIFECYCLE_SHUTDOWN_REASONS`, instead of rejecting the event.
