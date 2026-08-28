# Desktop build

Station's desktop app is a Tauri v2 application. A normal build consumes only
committed repository inputs: it must not require generating icons, schemas, or
a Cargo lockfile by hand.

## Prerequisites

- Node 24, as declared by `.nvmrc` and `package.json`
- npm 10 or newer
- the stable Rust toolchain
- Tauri's platform prerequisites for your operating system

On Ubuntu 22.04, the clean-checkout CI lane installs:

```sh
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf \
  libsoup-3.0-dev libjavascriptcoregtk-4.1-dev
```

See Tauri's
[prerequisites](https://v2.tauri.app/start/prerequisites/) for current
macOS, Windows, and Linux requirements.

## Verify a fresh checkout

```sh
npm run dependencies:ci
npm run verify:desktop-clean-checkout
```

The supported root-checkout bootstrap installs dependencies inertly, then runs
only the reviewed lifecycle allowlist, Station's patch step, and Git-hook
setup. Do not substitute raw `npm ci` for this boundary.

The verifier checks that `src-desktop/tauri.conf.json`, `Cargo.toml`,
`Cargo.lock`, and every configured bundle icon are regular files tracked by
Git. It then runs the supported compile command verbatim:

```sh
npm run tauri -- build --debug --no-bundle
```

Finally, it compares NUL-delimited Git status snapshots from before and after
the build. Pre-existing intentional worktree edits are preserved, while new
tracked or unignored generated residue fails with the affected path. Expected
caches and outputs such as `dist-*` and `src-desktop/target/` remain ignored.

Desktop-affecting pull requests run the same npm command in
`.github/workflows/desktop-clean-checkout.yml`; the workflow does not carry a
second copy of the verification logic.

## Startup readiness boundary

Packaged desktop startup has an explicit readiness and recovery boundary. Read
[Recover a desktop start](../user/native-recovery.md) for the user behavior,
logs, second-launch/tray distinction, and evidence limits. Read [Native shell
verification](native-shell-verification.md) for the exact source checks and
the physical-platform `NOT_VERIFIED` matrix. These build checks do not prove a
native window, dialog, tray, or release package.

## Committed-input policy

`src-desktop/Cargo.lock` is committed because Station is an application and
needs the same resolved Rust graph across developer machines and CI. This
matches Tauri's
[configuration guidance](https://v2.tauri.app/develop/configuration-files/#cargotoml).

All icons referenced by `bundle.icon` are committed. Icon generation is a
deliberate asset-maintenance operation when source artwork changes—not a
normal build prerequisite. See `src-desktop/icons/README.md`.

## Reviewed Tauri versions

Verified against npm and crates.io on 2026-08-15, Station uses the latest
published direct Tauri versions:

- Rust `tauri` 2.11.5
- Rust `tauri-build` 2.6.3
- npm `@tauri-apps/api` 2.11.1
- npm `@tauri-apps/cli` 2.11.4

Tauri recommends keeping the JS API and Rust core on compatible minor lines;
Station keeps the resolved npm and Cargo graphs in their lockfiles. Check
Tauri's
[dependency update guide](https://v2.tauri.app/develop/updating-dependencies/)
before changing either side.

## Desktop Content Security Policy

Station uses one explicit Tauri `app.security.csp` map and deliberately omits
`devCsp`. Packaged assets receive that policy through Tauri; the external Vite
development server imports the same map, sends it as an HTTP response header,
and adds one process-random script nonce to its transformed nonce marker.
Tauri asset-CSP mutation remains enabled, allowing its build to add the
hashes/nonces that bundled assets require.

| Directive | Rationale |
| --- | --- |
| `default-src 'none'` | Fail closed for any resource class Station has not named explicitly. |
| `script-src 'self' 'wasm-unsafe-eval'` | Bundled UI/WebAssembly only; no remote scripts, `unsafe-inline`, or `unsafe-eval`. |
| `style-src` | Existing runtime/plugin styles require inline styles; this exception does not apply to scripts. Fonts are self-hosted (#2648), so no external stylesheet origin is allowlisted. |
| `connect-src` | Tauri's `ipc:`/`http://ipc.localhost` transports plus Station user-selected `http:`, `https:`, `ws:`, and `wss:` endpoints. |
| `font-src` | Bundled/data fonts only — UI faces are vendored under `src-ui/public/fonts/` (#2648); no remote font CDN. |
| `img-src`, `media-src`, `frame-src` | Tauri `asset:`/`http://asset.localhost` where applicable, plus existing `data:`, `blob:`, `http:`, and `https:` content. MCP frames retain their separate sandbox and policy. |
| `worker-src` | Bundled and blob-backed diff workers. |
| `manifest-src`, `form-action` | Same-origin application metadata and forms only. |
| `object-src`, `base-uri`, `frame-ancestors` | All denied to prevent object embedding, base replacement, and framing Station. |

Dynamic installed plugins no longer receive Station's shell nonce **in a
browser**: a same-origin bundle is loaded by plain `<script src>`, which
`script-src 'self'` admits on its own, and the server no longer publishes the
response nonce as a page global at all (station#4287). Handing a nonce to
plugin code let it mint further nonce'd scripts, remote ones included, so the
policy constrained everything except the code it was written for.

In the **desktop shell** the bundle is cross-origin — the document is Tauri's
asset origin while the bundle lives on the supervised server's loopback origin
— so `'self'` cannot admit it and the fetched bytes are still inlined under
the nonce Tauri replaces on Station's `data-station-csp-nonce` marker. That
residual is disclosed rather than closed: closing it needs the desktop host to
serve plugin bundles from the shell's own origin. The marker
uses Tauri v2's `__TAURI_SCRIPT_NONCE__` build token, while the regression
ratchet prevents its silent removal. Untrusted MCP `srcdoc` content never
receives that shell nonce: interactive MCP Apps use the isolated frame origin,
and the opaque-origin fallback remains static so a resource cannot reuse
Station's nonce to bypass its own domain allowlist. The policy does not grant
remote scripts, extra native capabilities, a Tauri asset-CSP bypass, signing,
notarization, release publication, auto-update, or mobile packaging.

This contract does not prove code signing, notarization, installer
publication, auto-update delivery, or mobile packaging. Those require their
own release and real-device evidence.

## Packaged Browser Preview fixture (macOS)

The bounded physical-host fixture builds the current release package, creates
one marker-owned temporary `STATION_HOME`, pre-seeds exactly one Project and
Coding layout, and launches the real packaged app with its bundled service.
Its only preview target is a numeric-loopback HTTP server owned by the same
temporary fixture. It neither injects a development grant nor substitutes a
browser for the packaged renderer.

```sh
PATH="$HOME/.local/share/mise/installs/node/24.19.0/bin:$PATH" \
  npm run fixture:browser-preview:macos
```

The command prints its owned home, service endpoint, loopback target, and
bounded event-log paths after the packaged service answers its identity route.
In the seeded Coding layout, open Browser Preview, use the printed loopback
target, then record discovery/grant use, input/focus, same-origin navigation,
remote-redirect, popup and download denial, resize/z-order, close, and
rediscovery/reopen. `Ctrl-C` stops the app and removes only a directory carrying
the fixture marker. Add `-- --keep` to retain the bounded evidence directory.

The loopback page also reports two bounded, browser-derived measurement sets to
the fixture event log: up to 24 initial `requestAnimationFrame` deltas and up
to 24 resize-event-to-next-frame deltas, plus a URL-free count of at most 12
resource initiator types. These are samples from the real Browser Preview page
only. They do not measure native-window CPU/memory, prove pane responsiveness,
or establish a performance threshold. Record the host, package identity,
sampling method, and `PASS`, `FAIL`, or `NOT_VERIFIED` verdict separately for
Browser Preview and each in-process pane; an unavailable GUI host remains
`NOT_VERIFIED` rather than a zero-valued measurement.

This is package/runtime evidence, not Developer ID, notarization, stapling, or
Gatekeeper evidence. Those checks remain separate release criteria.
