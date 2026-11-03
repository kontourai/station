---
'@kontourai/station-sdk': minor
'@kontourai/station-contracts': minor
---

`TerminalView` resets its emulator to a fresh terminal before a newly handed session replays, so a reattached terminal's history draws once instead of twice; a session `reset` does the same. A focused view now leaves Command chords (Mac) and Ctrl+Shift letter chords (elsewhere) it does not handle to the page, so host shortcuts work from it, and `terminalViewShortcuts()` lists the keys the view keeps as `TerminalViewShortcut` records.

Device settings add `terminalScreenReader`, a preference that is off by default.
