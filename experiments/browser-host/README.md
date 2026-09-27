# Browser-host experiments (Station #1376)

These compile-only fixtures are isolated from Station production paths. They
do not change `src-desktop`, activate a native capability, enable Tauri's
`unstable` feature in Station, register a command, or expose a plugin bridge.

For the current product Browser pane, use the
[Browser workspace guide](../../docs/guides/browser-workspace.md). These
fixtures investigate host APIs and restoration identity; they do not select the
product's active transport.

Run from the repository root after `npm run dependencies:ci`, with Node 24 and
Rust installed:

```sh
node --import tsx --test experiments/browser-host/scripts/workspace-pane-adapter.node.ts
cargo check --locked --manifest-path experiments/browser-host/tauri-separate-window/Cargo.toml
cargo check --locked --manifest-path experiments/browser-host/tauri-child-webview/Cargo.toml
```

The Node experiment imports the current Workspace Pane parser and declares its
project requirement inside `modes`. The audit found that its old top-level
`contextRequirement` made all four tests fail at descriptor admission; the
fixture now follows the parser's current shape.

The adapter is intended to receive an approved target separately from persisted
Pane data, reject native geometry/handles, and return an explicit external-open
action when no host is available. The Node tests cover these adapter decisions,
not a running Tauri or Electron host. See the
[fixture](scripts/workspace-pane-adapter.node.ts),
[adapter](scripts/workspace-pane-adapter.ts), and
[current descriptor contract](../../packages/contracts/src/workspace-pane.ts).

The separate-window crate proves that the stable Tauri API type-checks. The
child crate proves only that `Window::add_child` remains behind `unstable`; it
does not support a shipping selection. Neither command proves native
interaction, storage isolation, packaging, or a production security policy.
Those rows remain `NOT_VERIFIED` until release-package evidence exists for
each declared platform.
