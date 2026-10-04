# Desktop tray

Station's desktop shell implements a native menubar/tray item for its own local
runtime. It reads shared, secret-free saved-Station metadata from
`$STATION_ROOT/config/profiles.json`, selects the unique local entry whose
`localService.baseDir` owns this Desktop channel's admitted `STATION_HOME`, and
then validates that runtime's exact `service/<instance-id>.json` manifest. It
never guesses from `service/default.json`, filename order, or the shared global
default, so selecting another channel or a remote Station cannot retarget tray
service actions. For a Desktop-owned sidecar, it reports the built-in backend
but does not offer service controls. Desktop sidecars and installed services
claim the home through the same registry protocol, so a service
that starts while this app's sidecar holds the home refuses with a remedy,
and quitting never signals a service-owned backend. Startup
recovery and its evidence boundary live in [Recover a desktop
start](../user/native-recovery.md) and [Native shell
verification](native-shell-verification.md).

## Desktop companion lifecycle

When the desktop attaches to its verified local service, it records its current
executable and process birth identity in an owner-only
`runtime/desktop-companion.json` file in that service's home. The service's
existing supervisor checks that registration after proving its own backend is
still alive. It restores a missing tray with `--tray-only`, using that exact
executable, Station root, and runtime home. It does not scan installed apps,
select another channel, or create a second backend. Startup retries back off
from 30 seconds to five minutes; a tray failure does not tear down the service.

Background launches leave the main window hidden. A normal app launch or an
explicit window action still reveals it through the existing startup-readiness
authority. Closing the main window keeps the tray alive. Explicitly choosing
Quit pauses automatic tray restoration for the current service run; opening
the app or restarting the service enables it again. After logout, the next
service run can therefore restore the tray. Station does not fight a deliberate
quit. The separately installed service
continues running, as before.

A service with no desktop registration stays headless. Linux restoration requires the service’s graphical-session environment
(`DISPLAY` or `WAYLAND_DISPLAY`). A headless/lingering service without those
values does not launch GUI processes. Stopping the service stops its
companion supervision, but does not close a desktop app the user may be using.
Native process birth and the private registration must be verifiable before
restoration: a reused PID is not treated as the original tray, while ambiguous
liveness does not justify launching a duplicate.

## Health states

| State | Meaning | Poll cadence | Actions |
| --- | --- | --- | --- |
| Not installed | No valid service manifest is available | 10 seconds | Service destinations and controls disabled |
| Stopped | Both installed-service identity probes explicitly refused a connection | 10 seconds | Start when the current ownership snapshot admits it |
| Running | Matching identity responses, or the authenticated local proof described below | 10 seconds | Stop for the attached service; valid browser destinations enabled |
| Unhealthy | A timeout, error, partial response, non-200 response, or identity mismatch occurred | 10 seconds | Stop only for an owned attached service; valid browser destinations may remain enabled |

These rows describe installed-service health. The built-in sidecar has its own
supervisor phase and no installed-service Start/Stop control. Health alone does
not grant a service action: [`tray.rs`](../../src-desktop/src/tray.rs) combines it
with the current Desktop ownership snapshot. All states use the ten-second
interval from [`service_state.rs`](../../src-desktop/src/service_state.rs).

The tray reads `/api/system/identity` on the manifest server port and
`/__station/identity` on the manifest UI port. If API identity requires
authentication, it uses the existing owner-only local-grant startup proof,
binding the API to the selected home, environment, instance, and UI boot. A
401/403 alone never establishes health, and this proof mints no credential. It intentionally gives a
conservative health display: it verifies the instance ID but does not replace
the CLI's full SHA/boot-ID health proof. Use `station service status --json` as
the authoritative diagnosis.

The running, stopped, and unhealthy tray silhouettes are embedded PNG template
assets. macOS decodes the dedicated `@2x` variants for a sharp menubar icon;
Linux and Windows decode the matching 1x variants. Menu and icon mutations are
marshalled through Tauri's main thread.

## Menu and endpoint actions

The tray separates identity, health, and destinations instead of compressing
them into one passive backend row. An attached service exposes two explicit
actions: **Open Station UI (port N)** opens its validated UI listener and
**Open API docs (port N)** opens Swagger UI at `/ui` on its validated API
listener. A Desktop-owned sidecar exposes its API-docs port and labels the UI
as the desktop app because there is no second browser UI listener to claim.

The desktop app's **More actions** menu includes **Open desktop tray** on
desktop targets. macOS and Windows ask the native status item to reveal its
menu. Linux indicators do not support programmatic reveal through the current
host library; the app reports that limitation instead of treating the request
as successful. Normal indicator clicks remain available.

All endpoint actions are derived from the same exact Desktop ownership snapshot
as health and service controls. API docs accept only an exact loopback origin,
and that validated origin is also the menu item's enabled-state source; the
renderer cannot supply a URL, port, or path. Attached-service destinations are
disabled while the endpoint is stopped or not installed.

Built-in navigation is enabled only after the hidden main window has completed
its native startup-readiness proof. A tray destination is retained natively and
leased to the renderer after it subscribes, so disposal during delivery cannot
consume the native slot. The lease expires after 30 seconds and is invalidated
when the main window is destroyed or startup readiness restarts. Showing the
desktop app's own window remains available while the built-in backend is
starting or restarting; browser destinations remain health-gated.

On macOS, if another Tauri window keeps the process alive after the main window
closes, **Show Station UI** recreates the main window from the checked-in Tauri
configuration and requires a fresh identity and renderer-mount proof before
revealing its contents. Windows and Linux disable that item when the main window
is absent because their native reconstruction path is not implemented.

## Service actions and CLI parity

Open Station UI uses the owned runtime manifest's UI port. Start and Stop run the
installed checkout's absolute Node, `tsx`, and `scripts/station-cli.ts` paths
with an explicit PATH; the desktop process never trusts a GUI-launcher PATH.
The tray resolves only those source-checkout paths. A service installed from a
prebuilt archive (manifest `kind: "archive"`) runs `bin/station.mjs` instead, or
on macOS and Linux, for an installer-owned archive, the fixed service launcher
at `<install-root>/runtime/station-launcher.mjs` (#2675). Either way
the tray finds no command paths, reports it Unhealthy, and refuses its Start
and Stop actions; use that install's `station service` command.
For terminal diagnosis, carry the same manifest identity rather than allowing
the CLI to select a different default. For example, fill these values from
the admitted service manifest:

```bash
./station service status --instance=<instance-id> --base=<runtime-home> --port=<api-port> --ui-port=<ui-port> --host=<manifest-host> --json
```

Use `start` or `stop` in place of `status` only when intending that service
mutation. The tray supplies these arguments through the manifest's exact
installed checkout; use that same checkout for the terminal command.

On macOS, Start bootstraps an unloaded LaunchAgent and then uses
`launchctl kickstart -k`; Stop uses `launchctl bootout` so `KeepAlive` cannot
immediately relaunch it. Linux uses `systemctl --user start|stop`. Windows now
has the per-user Task Scheduler backend in
[`service-windows.ts`](../../packages/cli/src/commands/service-windows.ts), and
the tray enables admitted service actions there too. This is source wiring,
not a Windows packaged-tray acceptance result.

After Start or Stop, the tray performs an immediate refresh followed by three
two-second convergence polls before returning to its normal cadence.

## Manual tray checklist

Run this on a release build from an installed checkout; do not use the bundled
desktop server as the target.

1. In an authorized disposable setup, install a user service and launch the desktop shell. Record time to Running; ten seconds is the poll interval, not a bound on startup plus identity probes.
2. Choose Open Station UI and confirm the browser opens the owned runtime manifest's displayed UI port, not another channel's UI port.
3. Choose Open API docs and confirm Swagger UI opens at `/ui` on the displayed API port.
4. From the desktop app's More actions menu, choose Open desktop tray. On macOS or Windows, confirm the native menu appears; on Linux, record the explicit unsupported notice and confirm the normal indicator still opens.
5. Choose Stop. Confirm the tray moves through Stopped, `station service status --json` reports the unit inactive, and a macOS service does not relaunch through KeepAlive.
6. Choose Start. Confirm the service becomes Running, UI opens successfully, and `station service status --json` is healthy.
7. Change the manifest to an unreachable or mismatched endpoint in a disposable service home. Confirm the tray shows Unhealthy rather than Stopped.
8. On macOS, repeat Stop/Start after unloading the LaunchAgent and record that Start bootstraps then kickstarts it; record the menubar icon rendering at native scale.
9. On a supported Linux desktop, repeat steps 1–7 and record the tray implementation/environment result. Linux indicator support is best-effort across desktop shells; document a missing indicator as a limitation, not a passing verification.

The desktop release workflow is the cross-platform compile lane (macOS, Linux,
and Windows). `npm run verify:desktop-rust` is the local pure Rust/state test
lane; it does not prove a GUI, bundled-server, or release-matrix build.

The tray must not independently bypass main-window startup readiness. A tray
or second-launch activation defers while the main window awaits an authenticated
exact identity ticket, then uses the one reveal authority after ready. The
source test coverage and packaged-platform limits are recorded in [Native shell
verification](native-shell-verification.md); physical tray/second-launch
deferral and diagnostic/relaunch behavior remain **NOT_VERIFIED** on packaged
Stable, Beta, and Nightly builds.

## Desktop alerts while the window is hidden

The [native notification-feed consumer](../../src-desktop/src/notification_feed.rs)
reads `/api/notifications/deliveries` for the host-authorized active Station,
using that profile's credential and this installation's surface identity. It
runs outside the WebView with a 20-second polling interval, so hiding the main
window does not suspend this reader. The server delivery router has already
applied notification policy and redacted the content.

The [WebView adapter](../../src-ui/src/platform/native/deliveryFeed.ts) asks which
consumer owns the feed before reading it. It can offer its older local cursor
once during upgrade; the native reader persists its own cursor per Station
origin and returned surface. A focused main window suppresses an OS alert and
consumes that entry. OS refusal and timed-out calls are also consumed; a call
that could not be started can be retried. A crash or failed cursor write can
replay work, so this is not an exactly-once display guarantee.

Linux can close a notification already posted by this process. The current
macOS and Windows backends cannot retract an already displayed alert; they can
only suppress one not yet posted. Clicking an alert focuses Station and passes
a validated in-app path to the main WebView. It does not open an arbitrary
external URL. Source and test fixtures establish these owners and limits;
OS permission, visible delivery, click behavior, and background operation still
need evidence from the packaged app on each platform.

## Logging (#1899)

The native shell (Rust/Tauri process — the tray, the notification feed, the
credential/profile bridge, `bundled_server_status`) logs through
[`tauri-plugin-log`](https://github.com/tauri-apps/plugins-workspace), not
`eprintln!`. A terminal launch still sees stdout; a double-clicked `.app` — the
common case a bare `eprintln!` never reaches — uses a file target when its
directory is writable. If that preflight fails, startup continues with stdout
only. File logging is best effort, not guaranteed crash/panic capture.

**Stable channel paths** (Tauri's `app_log_dir()` convention):

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Logs/io.kontourai.station/station.log` |
| Linux | `~/.local/share/io.kontourai.station/logs/station.log` (or `$XDG_DATA_HOME` if set) |
| Windows | `%LOCALAPPDATA%\io.kontourai.station\logs\station.log` |

Beta, Nightly and Dev use their own application identifier in these paths.
The [native shell guide](native-shell-verification.md#logs-and-diagnosis-boundary)
lists the release-channel paths and service-log distinctions.

This is the **desktop shell's own** log — distinct from the per-user Station
service's log (`$STATION_HOME/logs/<instance>-service.{out,err}.log` on
macOS/launchd, `$STATION_HOME/logs/<instance>-service.log` on Windows, or the
systemd journal — `journalctl --user -u station-<instance>` — on Linux, which
writes no log file at all). `bundled_server_status`'s payload carries both:
`desktopLogPath` for this process, and `logPath`/`errorLogPath` for the
per-user service when this platform's service manager actually writes one
(`null`, never a fabricated path, when it doesn't — e.g. always on Linux).

**Verbosity**: set `STATION_DESKTOP_LOG_LEVEL` to `trace`, `debug`, `info`
(default), `warn`, `error`, or `off` before launching. An unset, blank, or
unparseable value falls back to `info` — an unparseable value also logs a
`warn` once at startup naming the invalid value, rather than silently
swallowing the misconfiguration.

**Rotation**: `RotationStrategy::KeepSome(5)` retains up to five archived files
plus the active file. The configured 5 MiB threshold triggers rotation; a
single buffered entry can exceed it. It is not a hard per-file or 25 MiB total
ceiling. The owner is the log-plugin setup in
[`lib.rs`](../../src-desktop/src/lib.rs).

For a hidden-window timeout, a sidecar failure, or a distinction between this
shell log and service/server logs, use [Recover a desktop
start](../user/native-recovery.md). Logs are diagnostic evidence, not proof
that native chrome was displayed or that a renderer recovered.

Service install reserves the home and writes policy before starting its OS
backend. A bare `station service run` takes the same atomic claim itself,
recording a service owner with its PID and birth on a fresh home; installed
policy is preserved when present. If Desktop or another live owner holds the
home, the supervisor stays alive without running Station, polling with backoff
capped at 30 seconds and logging reason changes. Once the owner is gone it
claims and starts. Lost ownership at readiness or on an existing five-second
health tick stops and reaps Station before the same wait. Recovery waits for a
live replacement at the same service id, and retraction checks PID and birth.
An unreadable tick read keeps Station running until the next tick; a
successful read showing a missing or different owner triggers recovery.
An unreadable startup claim still fails closed.

Desktop publishes the child PID/birth immediately after spawn, before Listening,
retaining the fence while an orphan is shutting down. This does not make spawn
and publication one atomic OS operation. The Dockerfile's existing supervisor
command needs no policy registration. Direct `command-station.js` launches
remain unfenced, including containers invoking that entry point; a `0.0.0.0`
listener is reachable through their exposed/published ports.
