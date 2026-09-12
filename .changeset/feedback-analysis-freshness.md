---
'@kontourai/station-sdk': patch
---

Invalidate feedback guidelines and status after ratings are saved or removed, so clients refresh derived preferences and pending-analysis state.

Preserve configured cache invalidations when a successful mutation's observer throws, while keeping that observer failure visible to its caller.
