---
"@kontourai/station-sdk": patch
---

Release browser event listeners from the targets where the SDK registered them when an SSE connection ends. Ordinary page exits still abort the stream, and back-forward cache navigation keeps it available.
