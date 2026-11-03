---
'@kontourai/station-sdk': minor
'@kontourai/station-contracts': minor
---

`TerminalView` resets its emulator to a fresh terminal before a newly handed session replays, so a reattached terminal's history draws once instead of twice; a session `reset` does the same. A focused view now leaves Command chords (Mac) and Ctrl+Shift letter chords (elsewhere) it does not handle to the page, so host shortcuts work from it, and `terminalViewShortcuts()` lists the keys the view keeps as `TerminalViewShortcut` records.

Device settings add `terminalScreenReader`, a preference that is off by default.

`TerminalSession.restart()` starts an exited program again under the same id. `TerminalView` shows copy and paste outcomes on screen, keeps its context menu inside the viewport, defaults to 12px glyphs (14px on a phone), names its arrow keys as arrows, and no longer re-themes on geometry-only style writes to `<html>`; `rootThemeSignature` and `ROOT_THEME_ATTRIBUTES` are exported for hosts that watch the same inputs.

Settings labels the terminal history limits "Maximum history per terminal" and "Maximum total history".
