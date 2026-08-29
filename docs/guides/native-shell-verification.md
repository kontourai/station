# Native shell verification

This contributor and operator guide separates source-level, browser, and
physical-native evidence for desktop startup recovery. It is intentionally not
admitted to public Pages: it names implementation seams and verification
boundaries rather than providing an end-user recovery path. Use [Recover a
desktop start](../user/native-recovery.md) for that public path.

## What can run today

Run the changed selector first, then the exact focused checks it selects:

```sh
npm run test:changed -- --base=origin/main --explain
npm run test:focused -- scripts/__tests__/startup-readiness-static.test.ts src-ui/src/platform/native/__tests__/startupReadiness.test.ts
npm run verify:desktop-rust
```

The static test pins release-channel hidden-window configuration and the one
native reveal authority. The UI test proves the renderer retries an exact
generation and refuses an owned sidecar with no valid ticket. The Rust lane
proves pure readiness and sidecar-supervisor transitions, including stale
generation, deadline, retry, service recovery-surface recommit, and the
four automatic respawns before the fifth counted exit is terminal. None launches
a packaged app or sees a native dialog.

For the existing hostile-plugin browser test, use a distinct disposable home,
a unique instance, and an OS-allocated non-default port block. Keep allocation,
start, Playwright, and cleanup in the **same shell** so the identity variables
cannot be lost between terminals:

```sh
proof_instance="native-shell-proof-$(date +%s)-$$"
eval "$(node --input-type=module - <<'NODE'
import { findFreePortBlock, findFreePortOutside } from './scripts/lib/free-ports.mjs';
const serverPort = await findFreePortBlock(4);
const uiPort = await findFreePortOutside(serverPort, 4);
console.log(`proof_server_port=${serverPort}`);
console.log(`proof_ui_port=${uiPort}`);
NODE
)"
cleanup() {
  ./station stop --instance="$proof_instance" --port="$proof_server_port" --ui-port="$proof_ui_port" || true
}
trap cleanup EXIT HUP INT TERM
if ! ./station start --instance="$proof_instance" --temp-home --port="$proof_server_port" --ui-port="$proof_ui_port"; then
  exit 1
fi
PW_BASE_URL="http://localhost:$proof_ui_port" npx playwright test tests/plugin-host-security.spec.ts
```

The spec stages a hostile remote plugin that attempts parent storage/DOM,
parent globals, a Tauri bridge call, a blocked network call, over-scoped API,
and navigation. It verifies browser-frame containment and visible declaration
mismatch handling. It is a browser test: it cannot observe an invocation from
inside a real Tauri WebView, so it cannot prove native IPC denial. Do not
remove the native consent override on this evidence; the missing in-shell
harness is [#2495](https://github.com/kontourai/station/issues/2495).

The allocation checks availability before the CLI binds, so rerun the
allocation if the targeted start reports that the block became contested. The
start command is the ownership preflight: it carries the unique instance and
both allocated ports. Playwright runs only after that command returns
successfully. The cleanup trap targets the same instance and both ports on
normal exit or interruption; it does not select another contributor's service.
Do not reuse default ports or reset a normal Station home for this proof.

`--temp-home` is deliberately incompatible with `station service` because a
service needs a durable home.

## Startup and sidecar interpretation

The truth-bearing startup source is
[`src-desktop/src/startup_readiness.rs`](../../src-desktop/src/startup_readiness.rs):
the native host may reveal only after its invoke initialization task observes
the exact main WebView without waiting for application chunks, and its authenticated proof commits the ticket matching
the current generation, instance ID, boot ID, and API base. The native host arms one
30-second deadline, shows Retry/Exit once per epoch, and routes Retry according
to ownership in [`src-desktop/src/lib.rs`](../../src-desktop/src/lib.rs).

The sidecar supervisor in
[`src-desktop/src/bundled_server_state.rs`](../../src-desktop/src/bundled_server_state.rs)
uses 1 s, 2 s, 4 s, and 8 s crash backoff for its four automatic respawns. The
fifth counted exit is terminal; it does not schedule a fifth respawn. A manual
restart resets that attempt count.
`STATION_HOME_RESET_REQUIRED` is terminal for this loop: diagnose the selected
home; do not call it a retryable boot failure.

Interpret evidence narrowly:

| Observation | It establishes | It does not establish |
| --- | --- | --- |
| Rust readiness/supervisor test passes | State-machine transition contract | Tauri window visibility, dialog rendering, real process lifetime, or package behavior |
| Renderer startup-readiness test passes | Browser-side ticket/identity proof logic | Authenticated IPC behavior inside a Tauri WebView |
| Browser hostile-plugin spec passes | Isolated browser-frame containment | Native plugin IPC denial or a release-shell sandbox |
| Sidecar status reaches `failed` after five attempts | Supervisor exhausted automatic sidecar restarts | Cause of the child failure or renderer recovery |
| `STATION_HOME_RESET_REQUIRED` is logged | An incompatible home blocked sidecar startup | Which files may safely be deleted; use backup/reset policy before acting |

There is no current command that kills a Tauri renderer mid-session, no
bounded native renderer-reload implementation, no EPIPE recovery test, and no
packaged startup/retry/Exit harness. Do not invent a `tauri-driver` command or
claim that the browser test exercises those features. Those gaps are [#2006](https://github.com/kontourai/station/issues/2006).

## Logs and diagnosis boundary

The desktop host writes its own log through `tauri-plugin-log`. The configured
application identifier selects the shell log directory, so each release channel
has a distinct path:

| Channel | Tauri identifier | macOS | Linux | Windows |
| --- | --- | --- | --- | --- |
| Stable | `io.kontourai.station` | `~/Library/Logs/io.kontourai.station/station.log` | `$XDG_DATA_HOME/io.kontourai.station/logs/station.log`, or `~/.local/share/io.kontourai.station/logs/station.log` | `%LOCALAPPDATA%\io.kontourai.station\logs\station.log` |
| Beta | `io.kontourai.station.beta` | `~/Library/Logs/io.kontourai.station.beta/station.log` | `$XDG_DATA_HOME/io.kontourai.station.beta/logs/station.log`, or `~/.local/share/io.kontourai.station.beta/logs/station.log` | `%LOCALAPPDATA%\io.kontourai.station.beta\logs\station.log` |
| Nightly | `io.kontourai.station.nightly` | `~/Library/Logs/io.kontourai.station.nightly/station.log` | `$XDG_DATA_HOME/io.kontourai.station.nightly/logs/station.log`, or `~/.local/share/io.kontourai.station.nightly/logs/station.log` | `%LOCALAPPDATA%\io.kontourai.station.nightly\logs\station.log` |

These are separate from installed service output. macOS LaunchAgents write
`<STATION_HOME>/logs/<instance>-service.out.log` and
`<STATION_HOME>/logs/<instance>-service.err.log`; Windows writes the one
`<STATION_HOME>/logs/<instance>-service.log`; and Linux service output is only
`journalctl --user -u station-<instance>.service`, so it truthfully has no
service log-file path. The public recovery guide links here because this
operator detail is not admitted to Pages.
Set `STATION_DESKTOP_LOG_LEVEL=debug` or `trace` before launch when collecting
a reproduction, and restore the normal level afterward. The file target is
best effort: if its directory is not writable, the host continues with stdout
only. Rotation bounds retained shell files; it does not make an abrupt native
abort durable.

Use these commands for their separate scopes:

```sh
station doctor
station service status --json
```

Doctor reports local tool and runtime prerequisites, not native-window state.
Service status checks a durable installed service, not a Desktop-owned sidecar.
The shell log can show a timeout warning, a secondary-launch request, or an
invalid desktop log level; it cannot prove that a dialog was visible, that a
user chose Retry/Exit, that a window drew, or that a macOS Apple Event callback
did not panic before output flushed.

For the macOS abort class, record separately whether launch used Finder/Dock
or a direct executable: [#3496](https://github.com/kontourai/station/issues/3496)
reports the Apple Event path as the observed distinction. There is currently
no persisted panic hook or reproducible trigger, so preserve the package,
system crash report, timestamp, channel, and launch method rather than claiming
the normal shell log explains it.

## Physical evidence matrix

| Target or behavior | Current runnable evidence | Required physical evidence | Status |
| --- | --- | --- | --- |
| macOS packaged startup, Retry/Exit, Finder/Dock/reopen | Rust/static/UI checks | Installed package, actual native window/dialog, and launch-method record | **NOT_VERIFIED** |
| Windows packaged startup, second launch, tray | Rust/static/UI checks | Installed package, actual shell/tray and service-backend record | **NOT_VERIFIED** |
| Linux packaged startup and indicator behavior | Rust/static/UI checks | Installed package on a supported desktop shell, indicator result recorded | **NOT_VERIFIED** |
| Android/iOS startup recovery | No equivalent desktop readiness harness | Real device and a defined mobile recovery contract | **NOT_VERIFIED** |
| In-shell hostile plugin IPC denial | Browser Playwright only | Tauri-WebView harness observing hostile IPC denial | **NOT_VERIFIED** (#2495) |
| Renderer death, boot-crash reload cap, EPIPE | No implementation-level proof | Native kill/boot-crash/closed-pipe evidence and bounded recovery assertions | **NOT_VERIFIED** (#2006) |
