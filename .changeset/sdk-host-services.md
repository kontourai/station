---
"@kontourai/station-sdk": minor
"@kontourai/station-cli": minor
---

Add public host services for in-process plugins. `useShortcut` registers a shortcut in Station's shortcut registry, where it is listed in the shortcut list and Settings and suppressed under modals. `useShortcutScope` turns on a plugin-owned scope for `when`. `useHost()` provides `clipboard.writeText`, `openExternal` (http and https only), and Station's `prompt` and `confirm` dialogs. `useHostFacts()` returns the pane host's device facts.

Station refuses plugin shortcuts on the reserved command palette, Settings and shortcut-list chords, and namespaces plugin shortcut ids so they cannot replace Station's own. `useKeyboardShortcut` and `useKeyboardShortcuts` are deprecated in favour of `useShortcut`. `station dev` supplies all four new hooks with the same refusals.
