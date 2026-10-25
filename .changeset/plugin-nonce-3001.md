---
"@kontourai/station-core": patch
---

Refuse cross-origin in-process plugin bundles and draft previews instead of executing fetched bytes with the shell CSP nonce. Same-origin bundles keep loading by URL without a nonce. Native shells with a separate asset origin must use the Station browser UI for these extensions until same-origin native delivery is available.
