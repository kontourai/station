---
"@kontourai/station-sdk": patch
"@kontourai/station-shared": patch
---

Keep independent-review polling alive until it settles and release its abort listener after each poll. Operating-state, task-graph, attention, work-item and task-memory requests now reject with `StationHttpError` (status and code) instead of a parse error when a reply is refused or is not JSON. `useNotifications().dismiss` rejects when the server refuses, `AutoSelectModal` resets its selection when the query changes, and the terminal view ends a scrollbar drag on cancel and no longer re-renders for unchanged frames. Station Shared adds a `base64url` encoder that the SDK and Connect now share.
