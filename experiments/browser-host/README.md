# Browser-host experiments (Station #1376)

These compile-only fixtures are isolated from Station production paths. They
do not change `src-desktop`, activate a native capability, enable Tauri's
`unstable` feature in Station, register a command, or expose a plugin bridge.

Run from the repository root with Node 24 and Rust installed:

```sh
npx tsx --test experiments/browser-host/scripts/workspace-pane-adapter.node.ts
cargo check --manifest-path experiments/browser-host/tauri-separate-window/Cargo.toml
cargo check --manifest-path experiments/browser-host/tauri-child-webview/Cargo.toml
```

The Node experiment follows the current Workspace Pane `1.0` descriptor and
instance identity boundary. An approved target arrives separately from
persisted Pane data; native geometry and handles are rejected. If no native
host is available, the experiment produces an explicit external open action.

The separate-window crate proves that the stable Tauri API type-checks. The
child crate proves only that `Window::add_child` remains behind `unstable`; it
does not support a shipping selection. Neither command proves native
interaction, storage isolation, packaging, or a production security policy.
Those rows remain `NOT_VERIFIED` until release-package evidence exists for
each declared platform.
