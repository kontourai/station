# Desktop build

Station's desktop app is a Tauri v2 application. A normal build consumes only
committed repository inputs: it must not require generating icons, schemas, or
a Cargo lockfile by hand.
This is a build contract, not a claim that this review built or launched every
platform. Keep compile, native interaction, signing and provider receipts separate.

## Release updates

The desktop shell owns its own updates (`src-desktop/src/desktop_update.rs`).
The native updater is registered only when the build carries usable
endpoint/key configuration; an ordinary development build has none and reports
no update channel. A configured app checks about 20 seconds after it starts and
then hourly by wall-clock time while it runs, including tray-only (after the
computer sleeps past a due check, it checks within about 30 seconds of
waking); there is no OS job.

Updating has three separate steps:

1. **Download.** Open **Updates** in the sidebar, including its collapsed
   rail or mobile drawer, to review app and connected-server updates in one
   panel. Its **Desktop app** section offers **Download update**; the same
   controls remain in Settings → System → **Desktop app updates**. The
   **Automatic download** setting (Never, After 24 hours, Immediately; default
   After 24 hours) decides when it downloads without a click; the 24-hour clock
   starts when that version is first seen and survives restarts. A manual
   download always works. Downloading shows byte progress and never restarts
   anything. The download is written to the app's cache directory with its
   SHA-256 and release manifest; it is not kept in memory while it waits.
   During the download itself the updater plugin still buffers the whole
   package in memory.
2. **Confirm.** A downloaded update offers **Restart to update**, which only
   opens a confirmation. When the app's built-in server serves this window,
   the confirmation lists the running agent turns the restart interrupts; an
   installed service or another server keeps running.

   A downloaded update survives quitting. Shortly after the next start (off
   the window's startup path; the state reads checking meanwhile, and a Check
   pressed then is refused) the app offers
   it again if the release is still newer than the app and the package passes
   the updater's signature check. That check requires the signature to name
   the package's version. macOS updater archives are signed that way only
   from the first release that includes #3851 (`tauri signer sign
   --app-version`); a package from an earlier macOS release is deleted at the
   next start and must be downloaded again. Windows and Linux archives are
   signed by the Tauri bundler, which records the version. After restoring,
   the app asks the release feed once whether it still offers that version: a
   withdrawn or superseded release drops the package and shows the feed's
   current answer, and no answer keeps it. Otherwise a downloaded update is
   not re-checked against newer releases. A package that is damaged when
   **Restart now** reads it is deleted, and the state returns to idle with an
   install error; the next check offers the update again.
3. **Install and restart.** Only **Restart now** installs the download, after
   its digest and signature check, and restarts the app. **Restart now** waits
   until the running agent turns are listed. A failed install leaves the update
   downloaded and the app running, with the failure shown.

The Updates panel and Settings show check failures with the updater's own
text; the sidebar control does not announce routine check failures. The
desktop package includes the built-in Station server, so installing
this update replaces the app and its embedded server together. The webview
holds no updater or process plugin permission; it reads the native state and
asks the native shell to act.

The panel's **Connected server** section reuses the Settings server controls
and their permission and identity checks. An established built-in server
explicitly uses the app update above, including its restart confirmation.
An installed service or a remote server has its own labelled actions; there
is no combined update request or requirement that app and server versions
match. Supported services download first, then offer a confirmed restart or
**When idle**. The existing server observer keeps following an accepted
request if the panel is closed. Browser and mobile devices can open this
server section, and mobile app release links appear in the same panel.
**Update policies and details** opens Settings, where automatic-download
policies remain. Source-installation and manual host guidance remain reachable
from the server section; see [update mechanisms](nightly.md#update-checks-in-settings-source-check-vs-release-check).

Updating a separately running server remains a separate operation. Its source
checkout/build-stamp provenance does not establish the installed desktop app's
update channel. A GitHub DMG must not require a local Git checkout or a fabricated
`station-nightly-source.json` stamp to check its signed release feed.

When changing update controls, test the native state machine's failure paths
(`cargo test desktop_update`), and the UI against the native-writer fixtures in
`src-desktop/src/fixtures/desktop-update-states.json`.
An HTTP-successful release feed or a fixture-driven test does not prove
download, installation and restart of a packaged app; retain that runtime
verification separately.

## Packaged runtime

Desktop releases include a private `station-node` executable beside the app
executable, declared through Tauri's `externalBin`. The builder reuses the
portable server's pinned Node distribution and verifies its digest from
`config/portable-server-node-runtime.json`; only Node and its license are
extracted. Core desktop startup does not require a system Node installation.
Development/debug shells continue to use the developer's Node.

The native registry bridge and desktop-owned backend use that absolute private
executable. Built-in tool servers and server restart children use
`process.execPath`. The user's PATH stays unchanged, including in terminals and
agent commands. Optional device tools use an explicitly resolved user-installed
Node.js 24 or later and npm from that same installation, because their external
native add-ons are outside the app's signed bundle. Missing prerequisites block
only device setup with guidance; see
[device setup](mobile-device-workspace.md#configure-a-device-host). On macOS, the
release signer seals `station-node` with Kontour's Developer ID and only the JIT
entitlement; the outer app stays entitlement-free.

The frontend remains a production Vite build embedded in Tauri. The backend
ships compiled JavaScript plus its external runtime dependencies, native
libraries, schemas, skills, and licenses. Desktop staging omits backend source
maps while retaining them in the original build output for diagnostics. It also
removes reviewed SDK source/test trees and unused browser Cedar WASM variants.
RxJS keeps its Node CommonJS exports (also used by Node ESM imports), metadata
and license; its browser distributions and TypeScript sources are omitted.
node-pty keeps every architecture's prebuilds for the staging operating system
and omits prebuilds for other operating systems. Release packages use pinned
Node, but desktop debug builds select Node from the login PATH; its architecture
can differ from the staging Node (for example x64 Node under Rosetta on an
arm64 Mac). Keeping same-OS bindings preserves that debug launch path.
The stager and [pruning tests](../../scripts/__tests__/desktop-runtime-pruning.test.ts)
own these rules. File-count reductions are packaging evidence; they do not
measure Windows Defender scans or first-launch time.

### Claude executable trade-off

Keep the SDK's platform executable in the default package. The
[Claude adapter](../../src-server/providers/adapters/claude-adapter.ts) already
prefers a spawnable installed Claude when its version is suitable and otherwise
uses the SDK copy. Retaining that copy preserves executable availability on a
fresh offline install; provider authentication and model access are separate
prerequisites. Preferring an installed executable alone does not reduce bundle
or updater download size.

Fetching the fallback on first use could remove most of that binary's weight
from every full update, but introduces network availability, proxy, disk and
verification failures before an agent can start. A future opt-in distribution
would need a version/platform/architecture manifest with independently pinned
checksums, verification before atomic executable installation, interrupted
fetch recovery, explicit offline guidance, and platform signing/notarization
review. It must keep the bundled default until that journey and fallback are
qualified. This lane adds no downloader or reduced-function default.

A service and a desktop-owned backend use the same backend implementation but
have different process owners. Desktop starts a backend only after winning the
selected home's ownership claim. A live installed service owning that same home
prevents a second backend; a service for a different channel/home does not own it.
Installing a desktop update replaces its bundled runtime, not an independently
installed service's code or user data.

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
owned-process helper. Each retains its command deadline (10 seconds; the
node-spawning version probes — node, npm and tauri-cli — carry 30 seconds
because a cold Windows start can exceed the shorter bound while the tool is
healthy; Apple device discovery retains 15 seconds), bounded output and
process cleanup.
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

The Ubuntu job in
[desktop-clean-checkout.yml](../../.github/workflows/desktop-clean-checkout.yml)
runs the same npm command. The shared
[delivery workflow](../../.github/workflows/delivery-validation.yml) selects it
for affected PR heads after required source checks and for scheduled main
qualification after the full corpus succeeds; manual dispatch remains available.
It no longer starts independently on each `main` push. Its separate Windows job
exercises unsigned diagnostic NSIS packaging. Neither job's definition
establishes that the current revision passed.

## Startup cost and Linux graphics

Desktop caches a successful login-shell PATH lookup for the app process.
A failed lookup uses the current inherited PATH and retries on the next call
after a 30-second floor, so a slow shell cannot run on every request. An explicit
built-in server restart clears both the cache and retry floor before the next launch; quitting
and reopening the app also picks up shell configuration changes. Schema
preparation returns the supervisor identity in the same helper call;
service ownership is checked inside the legacy-preparation helper. The macOS
native waiting cover is requested before those bridge calls for foreground
launches; `--tray-only` launches leave the window hidden. A failed supervisor
identity lookup has its own error, separate from home-folder validation. Main-window
admission still requires the existing identity and renderer readiness proof.

Non-sidecar ownership status is refreshed at most once per minute. That
reduces idle helper processes but means an external service change can take
up to a minute, plus the next status poll, to appear. Tray Start/Stop invalidates
the cache before each of its four convergence polls; a failed attached-service
probe also invalidates it for the next status read. Launch and restart
claims still use the registry's current atomic ownership check. The running
sidecar supervisor checks child exit every two seconds; restart and shutdown
messages wake it immediately, and startup retains its 150 ms exit check.

The desktop sidecar enables Node 24's compile cache before loading the server,
under `<STATION_HOME>/cache/node-compile`. Home schema preparation precedes
that launch. Child-process environments scrub `NODE_COMPILE_CACHE`, including
terminal PTYs and engine children, so user Node programs do not write into this
server cache. The server does not enable a cache after loading its bundle:
that is too late to cache compilation of the entry point. Node's
`NODE_DISABLE_COMPILE_CACHE=1` opt-out remains supported; cache failure must
not prevent startup.

Server bundles are minified with function/class names retained. The esbuild
`linked` source-map setting is equivalent to the previous `true`: both emit an
external map and a `sourceMappingURL` comment. Normal server launches do not
enable Node's automatic source-map stack rewriting. For a diagnostic launch,
`node --enable-source-maps dist-server/command-station.js` rewrites stack frames
when the exact matching map is beside the bundle; mapping repeated error
stacks can add cost, so this is opt-in.

For offline diagnosis, preserve the exact bundle and map from the same build.
Do not use a fresh checkout's map for a different released bundle. To map one
raw stack frame, pass its 1-based line and column to Node's built-in mapper:

```sh
node --input-type=module - dist-server/command-station.js.map <line> <column> <<'JS'
import { readFileSync } from 'node:fs';
import { SourceMap } from 'node:module';
const [mapPath, line, column] = process.argv.slice(2);
const entry = new SourceMap(JSON.parse(readFileSync(mapPath, 'utf8')))
  .findEntry(Number(line) - 1, Number(column) - 1);
if (entry.originalSource === undefined) throw new Error('No mapping for this frame');
console.log(`${entry.originalSource}:${entry.originalLine + 1}:${entry.originalColumn + 1}`);
JS
```

Map inclusion in an installed release is a separate packaging concern. If the
map is absent, obtain the matching build output before attempting symbolication.

On Linux, before WebKitGTK starts, Station sets
`WEBKIT_DISABLE_DMABUF_RENDERER=1` only when a Wayland session and the loaded
proprietary NVIDIA kernel module (`/sys/module/nvidia`) are both detected.
This conservative fallback avoids known blank-window/compositing failures on
that combination. Any existing value, including `0` or an empty value, wins;
set the variable explicitly before launching to override the fallback.
X11, other drivers, and systems without that module retain WebKit's default.
Source policy and unit checks do not establish Linux hardware behavior.

## Startup readiness boundary

Packaged desktop startup has an explicit readiness and recovery boundary. Read
[Recover a desktop start](../user/native-recovery.md) for the user behavior,
logs, second-launch/tray distinction, and evidence limits. Read [Native shell
verification](native-shell-verification.md) for the exact source checks and
the physical-platform `NOT_VERIFIED` matrix. A readiness deadline never
restarts a still-booting sidecar; it offers Restart/Quit (in the macOS startup
cover, or a dialog elsewhere) while a late start can still reveal the window.
These build checks do not prove a native window, startup cover, dialog, tray,
or release package.

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

- Rust `tauri` 2.12.1
- Rust `tauri-build` 2.7.1
- npm `@tauri-apps/api` `^2.12.4`
- npm `@tauri-apps/cli` `^2.12.3`

Tauri recommends keeping the JS API and Rust core on compatible minor lines;
Station keeps the resolved pnpm and Cargo graphs in their lockfiles. The
manifest ranges do not by themselves identify the installed npm package version. Check
Tauri's
[dependency update guide](https://v2.tauri.app/develop/updating-dependencies/)
before changing either side.

The Rust process, deep-link, updater, haptics, and notification plugins use
the same minor lines as their npm packages. The notification plugin is pinned
to Rust `=2.7.0` with npm `2.7.0`; the updater uses Rust `=2.14.0` and npm
`2.14.0`. Matching versions satisfy the CLI version guard, while native build
and runtime evidence remain separate.
`tauri:context` checks the selected
toolchain and configuration; those checks alone do not prove a packaged shell
works.

## Desktop Content Security Policy

Station uses an explicit Tauri `app.security.csp` map and deliberately omits
`devCsp`. Windows overrides only its script/style sources with Wry's exact
HTTP protocol alias; other platforms admit only the custom scheme. Packaged
assets receive the resolved policy through Tauri; the external Vite
development server imports the base map, sends it as an HTTP response header,
and adds one process-random script nonce to its transformed nonce marker.
Tauri asset-CSP mutation remains enabled, allowing its build to add the
hashes/nonces that bundled assets require.

| Directive | Rationale |
| --- | --- |
| `default-src 'none'` | Fail closed for any resource class Station has not named explicitly. |
| `script-src 'self' 'wasm-unsafe-eval' station-plugin:` | Bundled UI/WebAssembly and the installed-plugin protocol. The Windows overlay replaces the scheme with `http://station-plugin.localhost`; that HTTP alias is never admitted on other platforms. No loopback wildcard, `blob:`, `unsafe-inline`, or `unsafe-eval`. |
| `style-src` | Existing runtime/plugin styles require inline styles; this exception does not apply to scripts. The same installed-plugin protocol sources admit Desktop plugin stylesheets. Fonts are self-hosted (#2648). |
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

In the **desktop shell**, the document is Tauri's asset origin while the
supervised server is `http://127.0.0.1:<port>`. The
[`station-plugin` handler](../../src-desktop/src/plugin_bundle_protocol.rs)
bridges only installed `bundle.js` and `bundle.css` assets. Its registration
closure requires an allowed webview label (`main` or
`workspace-pane-pop-out-<canonical-v4-UUID>`) **and** a per-launch capability
before scheduling blocking work or reading credentials. A label identifies a
webview, not a requesting frame. The capability is installed only in the top
shell realm at the exact app origin; an explicit top-frame guard also covers
WebView2's subframe injection of initialization scripts. Browser Preview and
unknown labels, or missing/wrong capabilities even inside an allowed webview,
receive an empty 403. A four-request limit **per label**, including queued work,
returns 429 when that window is full without consuming another window's
capacity. Each window's UI loads plugins sequentially.

The capability is a per-launch 256-bit secret checked in constant time, not
bound to label, path or port; those checks are separate. The UI loads
script/stylesheet URLs with the supervised port and capability query. These
loads do not navigate or store the URL in settings or routes. The URL can remain
in element `src`/`href`, `data-station-plugin` markers and resource timing
entries for the page's lifetime. Both elements and the protocol response use
no-referrer policy; responses also use no-store. Pane details, Home-role recovery
and reportable console capture redact native asset URLs through the shared redactor. Trusted
shell code and developer tools, including the unchanged developer console, can
still inspect the capability. No IPC command returns it. See the
[plugin delivery boundary](plugins.md) for the pinned Tauri source,
frame assumptions and remaining platform qualification. Rust
requires the current local owner and active native profile to agree, reads the
credential from native custody, disables redirects, caps decoded content at
16 MiB, and revalidates authority after reading. No renderer headers or
upstream response headers are forwarded. The installed endpoint checks its
recorded content digest and current artifact before delivery.

The external Vite development header retains the base policy, so Windows
Vite-based plugin loading remains unavailable; packaged Windows assets use
the platform overlay. Real-shell behavior requires separate qualification.

Other paths, hosts, methods, encoded traversal and noncanonical port queries
are refused before credential access. Draft revisions are not installed
artifacts and remain refused on Desktop; use same-origin browser draft
previews. A safe extension requires a separate Project/revision-bound path
authorized by the draft contract, a server-side digest check, and the same
webview gate, preferably with an isolated frame. Other cross-origin in-process
scripts remain refused (#3001), and
fetched bytes are never inlined under the shell nonce. The marker
uses Tauri v2's `__TAURI_SCRIPT_NONCE__` build token, while the regression
ratchet prevents its silent removal. Untrusted MCP `srcdoc` content never
receives that shell nonce: interactive MCP Apps use the isolated frame origin,
and the opaque-origin fallback remains static so a resource cannot reuse
Station's nonce to bypass its own domain allowlist. The policy does not grant
remote scripts, extra native capabilities, a Tauri asset-CSP bypass, signing,
notarization, release publication, auto-update, or mobile packaging.

This trusted-registry path is distinct from isolated plugin frames. In-process
plugins are not handed the nonce, but they run in the shell realm
and can read DOM `.nonce` and reach Tauri internals. This is the existing
in-process authority model; CSP does not isolate that code.
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
Activate Node 24 using your version manager. The command below identifies the
existing opt-in entry point, not a successful run or an instruction to bypass admission:

```sh
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
