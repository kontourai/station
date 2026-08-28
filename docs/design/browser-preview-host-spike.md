# Browser-preview host spike (Station archive#1376)

**Decision:** retain a stable, separate Tauri `WebviewWindow` as the bounded
desktop Browser Preview host. The follow-up implementation mints a fresh,
native-owned grant only after it resolves the running per-user service's
bounded loopback authority; the grant binds that authority to one target,
blocks navigation outside the exact approved loopback origin, and denies
popups/downloads. The external open action remains independently available.
Every platform claim not backed by the cited experiment is `NOT_VERIFIED`.

**Evidence refresh:** 2026-08-09; Station `origin/main` `e1259c782`, audited
t3code snapshot `c2f8cb7ca`, and the checked-in Station Tauri lockfile. t3code
remote main later advanced to `be01b287`; this spike makes no claim that the
audited snapshot is its current head.

## Boundary

This is host-selection research, not browser automation, a renderer launch,
or a desktop-framework migration. Workspace Pane `1.0` already owns portable
descriptor and instance data. The experiment follows its current identity
shape:

| Portable Pane data                                                    | Host adapter receives separately                         | Native-only runtime data                                                                  |
| --------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| descriptor id, renderer id/ref, instance id, state key, bound context | bounded requested target URL and current availability decision | opaque grant, resolved service endpoint, native handle, geometry, focus, z-order, cookie/store handle |

The approved target is deliberately not made descriptor or instance state.
Neither the experiment nor this document assigns an actual Station renderer,
availability result, or native capability.

## Current implementation facts

- Station pins `tauri = "=2.11.5"` and `tauri-build = "=2.6.3"`; the lockfile
  resolves those exact versions. The desktop dependency does not enable
  Tauri's `unstable` feature.
- Station's typed native capability report currently says
  `local-browser-preview` is enabled for a desktop compile target and
  unsupported for mobile. On desktop,
  `discover_local_browser_preview_target` resolves `service_backed_status`,
  accepts one literal numeric loopback target (`127.0.0.0/8` or `::1`), and
  applies one total one-second TCP-connect deadline before storing a one-time,
  60-second grant bound to the reached target and resolved bounded service
  endpoint. `localhost` is refused for the desktop preview and remains usable
  through the system-browser action; native discovery does not perform DNS.
  `open_local_browser_preview_window` accepts only that opaque grant id. The
  persisted Pane contract remains unchanged.
- The audited t3code snapshot `c2f8cb7ca` pins Electron `41.5.0`. Its desktop preview uses a
  partitioned, hardened `webviewTag` with a typed bridge and
  `will-attach-webview` enforcement; it also has `WebContentsView`-specific
  focus/zoom handling. It supplies security and lifecycle questions, not a
  Station dependency or migration direction.

## Candidate record

| Candidate                                      | Status                          | Reason                                                                                                                            |
| ---------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| External open action                           | Current behavior                | Cross-platform action without embedding untrusted content in Station's privileged UI.                                             |
| Stable Tauri separate `WebviewWindow`          | Bounded desktop implementation  | Uses stable navigation, popup, and download handlers to confine one exact loopback origin; package and platform interaction evidence remain required. |
| Tauri `Window::add_child`                      | Compile-only research           | Requires `unstable`; current upstream z-order and Wayland defects remain open.                                                    |
| Electron `WebContentsView`                     | Alternative implementation only | Good API evidence, but adopting it means an independently approved Electron/Chromium distribution and patch program.              |
| In-app frame                                   | Not a native host               | A web renderer may use a sandboxed frame only where the target permits it; refusal needs an explicit alternative action.          |
| Screenshot/stream transport or bundled browser | Out of scope                    | Adds capture, transport, credential, binary, and patch ownership without a bounded host decision.                                 |

## Isolated experiments

`experiments/browser-host/` has no production import path. It contains:

- a stable `WebviewWindowBuilder` compile fixture;
- an `unstable` child-webview compile fixture that proves only the feature
  boundary; and
- a Node test that keeps Pane `1.0` identities distinct from native runtime
  data and selects an external open action when native hosting is unavailable.

```sh
npx tsx --test experiments/browser-host/scripts/workspace-pane-adapter.node.ts
cargo check --manifest-path experiments/browser-host/tauri-separate-window/Cargo.toml
cargo check --manifest-path experiments/browser-host/tauri-child-webview/Cargo.toml
```

Compile success does not prove visual interaction, storage isolation,
permissions, CPU/memory, binary size, signing, or packaging.

## Platform and control matrix

| Platform            | Separate window         | Child webview                               | External open action        | Evidence required                                                                    |
| ------------------- | ----------------------- | ------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------ |
| macOS arm64         | compile + unit-tested policy | compile-only experiment                  | unit-tested command; package `NOT_VERIFIED` | signed-package interaction, navigation callback, store, and resource receipts |
| Windows             | compile + unit-tested policy | `NOT_VERIFIED`                           | unit-tested command; package `NOT_VERIFIED` | packaged WebView2 run and documented creation-deadlock handling |
| Linux X11 / Wayland | compile + unit-tested policy | unavailable on Wayland while archive#15656 is open | unit-tested command; package `NOT_VERIFIED` | packaged runtime, focus, resize, and bounds evidence |
| Web/PWA             | unavailable              | unsupported                                | unavailable                  | explicit external-open behavior remains `NOT_VERIFIED` in a browser host |
| Android / iOS       | unavailable              | unsupported                                | unavailable                  | independent mobile renderer/action decision; no multiwebview claim |

| Control                                          | Current result                                                                                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Station/Tauri/plugin authority                   | Dynamic preview labels are outside `capabilities/default.json`; no bridge, credential, plugin, or automation API is granted. Runtime package proof remains `NOT_VERIFIED`. |
| Navigation, popup, download, permissions         | Exact loopback-origin navigation is unit-tested; `window.open` and downloads are denied. Platform callback behavior remains `NOT_VERIFIED`. |
| Storage/cookies                                  | Builder requests incognito mode and does not persist a store handle. Platform storage isolation/clearing behavior is `NOT_VERIFIED`. |
| Crash and close                                  | Semantic external-open action is tested; live crash/recreation is `NOT_VERIFIED`.                                                                   |
| Focus, IME, resize, z-order, drag/drop, DevTools | `NOT_VERIFIED` on every shipping platform.                                                                                                          |
| Automation                                       | Explicitly outside this spike. A future broker needs separate authorization and visible ownership.                                                  |

## Upstream evidence

- [Tauri archive#15682](https://github.com/tauri-apps/tauri/issues/15682) remains open
  (child webview covers main webview content; checked 2026-08-08).
- [Tauri archive#15656](https://github.com/tauri-apps/tauri/issues/15656) remains open
  (Wayland child-webview bounds; checked 2026-08-08).
- [Tauri archive#11794](https://github.com/tauri-apps/tauri/issues/11794) remains open
  (mobile `add_child`; checked 2026-08-08).
- [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)
  is the current API reference for a separately approved Electron host.

## Production scorecard update (2026-08-09)

| Criterion | Status | Evidence / limitation |
| --- | --- | --- |
| Authoritative target/service admission | CONFIRMED (unit) | Rust resolves the running service authority, admits one literal numeric loopback target, makes one bounded TCP probe, then mints a target+endpoint grant. It distinguishes reachable/refused/unreachable where observable, rejects hostnames before discovery, rejects replay/expiry/retargeting, and removes the active binding when the native window is destroyed. Pane state persists none of this. |
| Redirect/navigation containment | CONFIRMED (unit) | Stable Tauri `on_navigation` permits only the original scheme, loopback host, and effective port; remote and alternate-loopback redirects are rejected. |
| Popup/download containment | CONFIRMED (static/unit) | Stable `on_new_window` returns deny and `on_download` returns false. |
| Renderer error projection | CONFIRMED (unit) | Native response has typed authority/grant/renderer codes plus `target-refused`, `target-dns-failed`, and `target-unreachable`. TCP reachability is observed before a grant; TLS response, final navigation, title/history, frame result, and renderer health remain unobservable. |
| macOS / Windows / Linux package interaction | NOT_VERIFIED | No signed/package runtime, callback, focus, resize, or crash evidence. |
| Web/PWA and Android/iOS | UNAVAILABLE | No embedded renderer is exposed; the existing capability state remains unsupported/unavailable. |
| Child webviews | NOT SELECTED | `unstable` remains disabled in Station; upstream z-order/Wayland/mobile limitations remain tracked above. |

**Go/no-go:** **conditional go for the bounded desktop implementation only.**
Do not expand it to a child webview, remote target, shared browser store,
automation, or a mobile/web renderer until the named package/runtime rows have
receipts. Tauri remains supportable for this slice; Electron is not reopened.

## Remaining expansion criteria

A dedicated implementation issue may start only with all of these explicit
requirements:

1. A descriptor/instance/state key maps to a stable host action, while each
   approved target is rechecked and all native handles/geometry remain runtime
   data.
2. macOS, Windows, Linux X11, and Linux Wayland release packages prove the
   selected behavior; unsupported rows expose an external open action or an
   unavailable state.
3. Hostile-origin tests prove no Station command, plugin, credential, storage,
   bridge, or automation authority crosses into preview content.
4. Navigation, popups, downloads, permissions, store clearing, IME, focus,
   resize, z-order, crash recovery, CPU/memory, package size, signing, and
   packaging have platform-specific receipts.
5. Any persisted-state change has a versioned migration or reset policy. No
   implicit compatibility read is permitted.

## Scope record

The original isolated spike remains limited to
`docs/adr/0017-browser-preview-host.md`, this record, and
`experiments/browser-host/**`. The bounded implementation changes only the
desktop host adapter and its platform-neutral caller; it does not change a
release configuration, package manifest, or Workspace Pane contract.
