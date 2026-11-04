---
"@kontourai/station-shared": patch
"@kontourai/station-sdk": patch
---

Add `@kontourai/station-shared/visual-viewport`, one visual viewport subscription per window that reads the geometry once per frame for every subscriber. The SDK's `AutoSelectModal` and Connect's connection manager modal now read it too, so inside the Android shell they size to the visible height above the keyboard like the app's own dialogs.

Add `@kontourai/station-shared/strict-indexeddb`, the strict-durability single-store IndexedDB transaction that Connect's broker routing grant storage and the app's relay credential custody now share instead of each carrying a copy.
