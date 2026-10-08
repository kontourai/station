# Desktop build

Station's desktop app is a Tauri v2 application. A normal build consumes only
committed repository inputs: it must not require generating icons, schemas, or
a Cargo lockfile by hand.
This is a build contract, not a claim that this review built or launched every
platform. Keep compile, native interaction, signing and provider receipts separate.

## Release updates

In the desktop shell, Settings → System → **Desktop app updates** →
**Check for desktop app updates** checks the updater configuration embedded in
the installed app. The native updater is registered only when the build carries
usable endpoint/key configuration; an ordinary development build may have none.
An available update can be installed with **Install desktop
app update and restart**. Manual checks expose failures and can be retried; the
automatic launch check remains quiet on check failure. The desktop package
includes the built-in Station server, so installing this update replaces the
app and its embedded server together.

**Connected Station server** is a separate server operation. Its source
checkout/build-stamp provenance does not establish the installed desktop app's
update channel. A GitHub DMG must not require a local Git checkout or a fabricated
`station-nightly-source.json` stamp to check its signed release feed.

When changing update controls, test native check failures, retries, installation
failure without restart, and desktop-only routing alongside server update tests.
Release native update handles when checks are replaced or their UI unmounts,
including late check responses. An active installation retains its handle until
the operation settles.
An HTTP-successful release feed or mocked plugin test does not prove installation
and restart of a packaged app; retain that runtime verification separately.

## Prerequisites

- Node 24, as declared by `.nvmrc` and `package.json`
- npm as the script interface and the pinned pnpm version in `package.json`
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

For a slow or stalled context report, run
`node scripts/tauri-context.mjs --platform windows --json --trace-probes`.
The report stays JSON on stdout; stderr records each spawned probe's stable
id, start/end phase, elapsed milliseconds and running/checked/failed/skipped
status. If an outer timeout interrupts the report, starts without matching
ends identify its active probes. Probe command limits and report exit status
remain unchanged.

Independent command and generated-tree probes run concurrently through the
owned-process helper. Each retains its command deadline (normally 10 seconds;
Apple device discovery retains 15 seconds), bounded output and process cleanup.
A stalled tool stays failed in the report and findings; it does not prevent
unrelated version probes from returning. The exported `buildContextReport`
builder returns a promise; its CLI caller awaits the completed report.
SIGINT and SIGTERM cancel active probes and await their process cleanup before
the CLI exits with status 130 or 143, without printing a partial report.

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

Finally, it compares NUL-delimited Git status entries from before and after
the build. A newly dirty path or unignored output fails with the affected path.
This is not a byte-preservation check: further changes to an already-dirty path
can keep the same status entry. Preserve and inspect intentional edits separately. Expected
caches and outputs such as `dist-*` and `src-desktop/target/` remain ignored.

The path-filtered Ubuntu job in
[desktop-clean-checkout.yml](../../.github/workflows/desktop-clean-checkout.yml)
runs the same npm command for PR heads, `main` pushes and manual dispatches.
Its separate Windows job exercises unsigned diagnostic NSIS packaging. Neither
job's definition establishes that the current revision passed.

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

The earlier 2026-08-15 registry review is historical. The current checkout
requests these direct versions; this list is not a claim that they remain the
latest upstream releases:

- Rust `tauri` 2.11.5
- Rust `tauri-build` 2.6.3
- npm `@tauri-apps/api` `^2.11.1`
- npm `@tauri-apps/cli` `^2.11.5`

Tauri recommends keeping the JS API and Rust core on compatible minor lines;
Station keeps the resolved pnpm and Cargo graphs in their lockfiles. The
manifest ranges do not by themselves identify the installed npm package version. Check
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

For bundles admitted to the trusted in-process
[`PluginRegistry`](../../src-ui/src/core/PluginRegistry.ts), a same-origin
browser bundle is loaded by plain `<script src>`, which
`script-src 'self'` admits on its own, and the server no longer publishes the
response nonce as a page global at all (station#4287). Handing a nonce to
plugin code let it mint further nonce'd scripts, remote ones included, so the
policy constrained everything except the code it was written for.

In the **desktop shell** that trusted bundle can be cross-origin — the document is Tauri's
asset origin while the bundle lives on the configured Station server origin
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

This trusted-registry path is distinct from isolated plugin frames. CSP is not
an isolation boundary against code deliberately admitted to the shell realm.
Capabilities in `src-desktop/capabilities/` separately scope native IPC; do not
widen them to make a build or plugin test pass.

This contract does not prove code signing, notarization, installer
publication, auto-update delivery, or mobile packaging. Those require their
own release and real-device evidence.

## Packaged Browser Preview fixture (macOS)

**Current limitation:** the checked-in fixture is not a working acceptance
recipe for today's home-admission contract. Its helper seeds the Project and
Coding layout under a temporary root, while the runner selects a nested
`instances/browser-preview` runtime home. The root has no saved-profile store
and already contains data, so Desktop's profile-store genesis check refuses
it before sidecar startup. The runner also writes evidence files into the
unversioned runtime home before schema admission; that independently causes
a schema refusal. Repair both initialization order and seed location before
using this fixture to claim packaged Browser Preview success.
The existing [fixture backlog](https://github.com/kontourai/station/issues/218)
was folded into the [packaged-platform epic](https://github.com/kontourai/station/issues/199);
its closed state is not a current successful-run receipt.

The owners are
[`browser-preview-packaged-fixture.mjs`](../../scripts/browser-preview-packaged-fixture.mjs),
its [filesystem helper](../../scripts/lib/browser-preview-packaged-fixture.mjs),
and Desktop home preparation in [`lib.rs`](../../src-desktop/src/lib.rs).
The command below identifies the existing opt-in entry point, not a successful
run or an instruction to bypass admission:

```sh
PATH="$HOME/.local/share/mise/installs/node/24.19.0/bin:$PATH" \
  npm run fixture:browser-preview:macos
```

The intended fixture builds a package, owns one temporary root and numeric-loopback
preview target, then waits for the packaged service's identity before printing
its evidence paths. It does not substitute a browser for the native renderer.
After repairing and qualifying startup, the intended checklist is: in the
seeded Coding layout, open Browser Preview, use the printed loopback
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
