---
"@kontourai/station-sdk": patch
---

Stop `useSessionInventoryQuery` and `useSessionInventoryGroupPage` from refetching forever after a failed read. Only lost authority (401, 403, or the route's non-disclosing 404) revokes cached inventory, and it tombstones the entries rather than removing them. A 503, a network failure or a projection the contract refuses is now an ordinary query error. Once a mount's own read has landed, a background refetch keeps the loaded projection in `data` instead of reporting it as loading.
