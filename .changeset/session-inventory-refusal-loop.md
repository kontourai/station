---
"@kontourai/station-sdk": patch
---

Stop `useSessionInventoryQuery` and `useSessionInventoryGroupPage` from refetching forever after a failed read. Only lost authority (401, 403, or the route's non-disclosing 404) revokes cached inventory. A 503, a network failure (status 0) or a projection the contract refuses (reported with the response's own status, usually 200) is now an ordinary query error. Once a read made during the current mount has succeeded, a background refetch keeps the loaded projection in `data` instead of reporting it as loading; a mount whose own read failed still shows nothing cached before it.

`clearSessionInventoryCache` now tombstones matching projection and page entries: it leaves `null` in the cache instead of removing them, so a mounted observer no longer re-creates and refetches a revoked query. Callers that tested for `undefined` after clearing should test for `null`.
