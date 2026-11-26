---
"@kontourai/station-sdk": patch
---

`useKnowledgeScanMutation` now also refreshes the project's knowledge namespaces after a scan, because a first directory scan registers the project's `code` namespace.
