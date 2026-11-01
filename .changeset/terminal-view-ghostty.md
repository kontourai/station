---
'@kontourai/station-sdk': minor
'@kontourai/station-contracts': minor
---

Add `@kontourai/station-sdk/terminal-view`: `TerminalView`, Station's terminal surface over Ghostty's libghostty-vt (v1.4.0) compiled to WebAssembly, with a WebGL2 renderer, canvas 2D fallback, IME and touch input, find, links, a context menu and a screen-reader text mirror. It renders any `TerminalViewSession`.

The pane host contract adds the closed built-in terminal target, `RelatedTerminalOpenRequest` (`{ kind: 'terminal'; binding; terminalId?; new?: { profile? } }`), and its bounded decoder; `terminal-transport` re-exports it as `TerminalPaneTarget`. `PaneRelatedPanesHost.open` accepts either target.
