---
"@kontourai/station-core": patch
---

Deliver Desktop installed plugin assets through a bounded host-authenticated protocol while refusing other cross-origin in-process bundles. Plugins are not handed the shell CSP nonce. In-process code still shares the shell realm, can read DOM `.nonce`, and can reach Tauri internals. Same-origin browser plugins and draft previews keep loading by URL; Desktop draft previews remain unavailable until their Project authorization contract has native delivery.
