# Recover a desktop start

This guide is for a packaged Station desktop app that stays hidden while it
starts, shows **Station is not ready**, or opens but then cannot reach its
local service. It describes the recovery behavior implemented in the desktop
host; it is not evidence that every platform's packaged app has been exercised.
Contributor and operator procedures are in the repository's
[native shell verification guide](https://github.com/kontourai/station/blob/main/docs/guides/native-shell-verification.md).

## What a normal packaged start does

Stable, Beta, and Nightly configure their main desktop window to start hidden.
For a Desktop-owned sidecar, the native host proves its exact generation,
instance ID, boot ID, and local API base. Revealing application content also
requires the main renderer to have mounted. The native shell starts the
identity proof; the renderer separately reports that it mounted. An old ticket
cannot reveal a newer sidecar.

If an installed service owns the home, or Desktop owns no sidecar, the host can
instead reveal the mounted connection/recovery surface. That does not establish
that a backend is reachable or ready. On macOS, an activation request can make
a native startup cover visible while readiness is pending; this cover does not
expose application content.

This avoids showing a usable-looking window before its protected local surface
is ready. The original native-startup work is recorded in
[archive#3808](https://github.com/kontourai/station-archive/issues/3808).

## When the window does not appear

If readiness has not completed after a 30-second startup epoch, the native host
normally shows one **Station is not ready** dialog with **Retry** and **Exit**.
A pending activation request can instead start another readiness epoch. An
activation after failure also resumes readiness; neither bypasses the proof
required to reveal content.

- **Retry** starts a new epoch. With a current owned-sidecar ticket, the first
  retry rechecks that ticket without restarting a potentially healthy backend.
  If that recheck fails to complete and you retry again, or no current ticket
  exists, Desktop asks its bounded supervisor to restart the sidecar. If a
  durable service owns the home, or no sidecar is owned, it requests the
  recovery surface again; it does not start or restart the durable service.
- **Exit** closes the desktop app. It does not reset data or remove a service.
- After an unexpected exit, the supervisor can respawn the sidecar four times,
  after 1, 2, 4, and 8 seconds. The fifth counted exit is terminal and reports
  failure. An owned-sidecar restart resets that attempt count; a ticket-only
  recheck does not. Neither proves that the underlying cause is fixed. The cap
  and fail-closed classification are covered by the linked native-startup work.

If the dialog reappears, stop retrying blindly and collect the bounded
diagnostics below. A data-home schema error containing
`STATION_HOME_RESET_REQUIRED` is deliberately fail-closed: restart attempts do
not repair it. Follow the exact `station home reset` conditions only after you
have a backup and have selected the intended home.

Some home or schema refusals occur before the supervisor starts. They show a
separate **Exit**-only dialog and start no backend. Repeatedly launching the app
does not repair the refused home.

## Check the local diagnosis

From the Station checkout or installed command, run:

```sh
station doctor
station service status --json
```

`station doctor` checks local prerequisites and readiness; it does not inspect
a Tauri renderer or prove that a packaged window was shown. `station service
status --json` checks an installed user service and its identity endpoints. It
does not diagnose a Desktop-owned sidecar, and its failure does not by itself
explain a hidden window.

Keep shell and service logs separate:

| What you need | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Desktop shell log | `~/Library/Logs/<app-identifier>/station.log` | `$XDG_DATA_HOME/<app-identifier>/logs/station.log`, or `~/.local/share/<app-identifier>/logs/station.log` | `%LOCALAPPDATA%\<app-identifier>\logs\station.log` |
| Installed service log | `<STATION_HOME>/logs/<instance>-service.out.log` and `<STATION_HOME>/logs/<instance>-service.err.log` | `journalctl --user -u station-<instance>.service` (no service log file) | `<STATION_HOME>/logs/<instance>-service.log` |

Choose the app identifier for your installed channel (Stable, Beta, or Nightly)
from the [channel log path table in the repository guide](https://github.com/kontourai/station/blob/main/docs/guides/native-shell-verification.md).

The desktop shell honors `STATION_DESKTOP_LOG_LEVEL` set before launch:
`trace`, `debug`, `info`, `warn`, `error`, or `off`. Its file rotation is
configured for up to five archived files plus the active log, with a 5 MiB
rotation threshold. This is not a hard file-size or total-size cap: an oversized
log entry can exceed the threshold. If the shell log directory is unwritable,
the host falls back to stdout. The server logging configuration is maintained
with the installed app. Logs can contain local data or secrets; redact them
before sharing.

## Second launches and the tray

An interactive second desktop launch, a reviewed deep link, and the macOS
reopen event ask the existing app to activate its main window. A background or
tray-only launch can suppress activation. While readiness is pending, content
reveal is deferred; macOS may show the native startup cover described above.
Once ready, the same reveal authority focuses the window.

The tray is a different surface: it reports the currently selected local
backend. For an installed service it can offer service actions; for a
Desktop-owned sidecar it labels the built-in service and does not use service
controls. Neither a tray click nor a second launch proves that startup readiness
completed.

## Evidence limits and open platform work

The source and focused tests cover state transitions and browser-renderer
logic. There is also a separate Tauri-WebView hostile-plugin harness. Its
existence is not a successful run: browser tests, source checks and an available
native harness must not be presented as packaged or physical-device evidence.

| Behavior | Current evidence | Status |
| --- | --- | --- |
| Hidden release window, exact ticket, timeout, retry, and activation deferral | Source configuration and pure Rust/UI test coverage associated with archive#3808 | **NOT_VERIFIED** on packaged macOS, Windows, and Linux shells |
| Hostile plugin IPC denial in a real Tauri WebView | Separate browser and real-WebView harnesses exist; the native lane was not run for this documentation review | **NOT_VERIFIED** here; historical gap recorded in [archive#2495](https://github.com/kontourai/station-archive/issues/2495) |
| Renderer/WebView death detection and bounded reload | Window recreation exists; no automatic renderer-death recovery or kill-the-WebView proof is established here | **NOT_VERIFIED**; [archive#2006](https://github.com/kontourai/station-archive/issues/2006) |
| EPIPE/closed-stdio handling | Server stdout guard and focused tests exist; no packaged closed-parent recovery journey was run here | **NOT_VERIFIED** on packaged shells; [archive#2006](https://github.com/kontourai/station-archive/issues/2006) |
| macOS Finder/Dock Apple Event launch panic diagnosis | The historical abort report does not establish a recoverable panic payload or current trigger | **NOT_VERIFIED**; [archive#3496](https://github.com/kontourai/station-archive/issues/3496) |
| Tray rendering, tray activation, and second-launch behavior on release builds | Pure-state/static routing associated with [archive#3808](https://github.com/kontourai/station-archive/issues/3808) | **NOT_VERIFIED** on packaged macOS, Windows, and Linux |
| Mobile startup and recovery | Desktop readiness code is desktop-only; no equivalent mobile recovery evidence is supplied here | **NOT_VERIFIED** on Android and iOS; historical documentation scope in [archive#3817](https://github.com/kontourai/station-archive/issues/3817) |

The related implementation history is
[archive#3808](https://github.com/kontourai/station-archive/issues/3808). An
archived issue's status does not establish current implementation or release
qualification; use the owning source, tests and exact platform receipts.
