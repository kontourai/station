---
'@kontourai/station-sdk': minor
'@kontourai/station-contracts': minor
---

Station now opens the closed built-in terminal target. A plugin calls `useRelatedPanes().open({ kind: 'terminal', binding, terminalId?, new? })` and Station shows that session as its own `terminal-pane:` dock pane, with the Tools by default.

The rules for an open:

- The binding (`project`, or `thread:<id>`), and any named session, must fall inside the caller's captured Project; otherwise the answer is `context-mismatch`.
- The viewer's own grant decides the rest: a new shell needs `terminal:operate`, and an existing session needs `terminal:observe`. Without `terminal:operate` the pane is read-only.
- `new` takes the `shell` profile only, which the server resolves. Any other profile is `unsupported`.

`@kontourai/station-contracts/workspace-terminal-pane` adds the pane's descriptor (`pane:builtin:workspace-terminal`) and occurrence helpers. The SDK root and `workspace-pane` entries re-export `RelatedPaneOpenTarget` and `RelatedTerminalOpenRequest`.
