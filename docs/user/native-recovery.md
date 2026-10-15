# Recover a desktop start

This guide is for a packaged Station desktop app that stays hidden while it
starts, says **Station is taking longer than usual to start**, or opens but
then cannot reach its local service. It describes the recovery behavior implemented in the desktop
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
a native startup cover visible while readiness is pending. It shows the app
icon and **Starting Station**, and it does not expose application content.

This avoids showing a usable-looking window before its protected local surface
is ready. The original native-startup work is recorded in
[archive#3808](https://github.com/kontourai/station-archive/issues/3808).

The short Station intro is separate from native readiness. If it has already
started visibly, a ready app finishes the name reveal and fades into the
workspace. It does not wait for a loading-animation cycle. Fast starts can skip
an unseen intro; reduced motion and recovery screens do not wait for it. Bringing
an existing window back or changing Stations does not replay the intro.

## When the window does not appear

A cold start can take longer than 30 seconds on a slow or busy computer. If
readiness has not completed after a 30-second startup epoch, Station keeps
starting and offers a choice once for that epoch:

- On macOS, the startup cover changes to **Station is taking longer than usual
  to start.** with **Restart** and **Quit** buttons. Return selects
  **Restart**; with keyboard navigation turned on, Tab moves between the two
  buttons and Space presses the focused one. Escape does nothing. While the
  cover is shown, typing and editing shortcuts are ignored; the Quit, Close,
  Hide and Minimize shortcuts still work, including on non-Latin keyboard
  layouts (where they use the key positions of a US keyboard). Closing the window only hides it: Station keeps starting, and the
  window comes back when you open Station again (Dock, launching it, or the
  tray). If Station was launched in the background (tray-only), this message
  appears when you open the window. If the cover cannot be shown, the dialog
  described next appears instead; it can stay open after the window appears,
  and its buttons are then ignored.
- On Windows and Linux, a **Station is taking longer than usual to start**
  dialog offers **Restart**, **Quit** and **Keep Waiting**. Closing it or
  pressing Escape is the same as **Keep Waiting**; only **Quit** closes the app.
  After **Keep Waiting**, the message comes back after 30 seconds, then 60,
  then every 2 minutes while Station still has not finished starting.

You do not have to choose. Desktop does not stop its local service when the
30 seconds pass. When the service finishes starting, the window opens without
any action from you (unless Station was launched in the background, or you
closed the window while waiting), and the macOS cover and its buttons
disappear. While that window is still waiting to open there is no time limit
on the service starting, including on a first launch, when Station creates
this computer's local connection only after the service is running. If the service fails instead,
waiting does not help: the **Restart** and **Quit** choices above still appear
when the 30 seconds pass, and Restart starts it again and lets Station finish
opening. If Station's window is already open (for example after you reload it,
or in a separate workspace window), it shows Station's recovery screen right
away if the service has stopped or failed, and after about a minute if the
service is still starting or restarting. On
Windows and Linux, the dialog
can stay open after the window appears; its buttons are then ignored. On
macOS, activating the app (Dock, second launch, deep link) shows the cover
again but does not restart anything.

- **Restart** starts a new epoch. With a current owned-sidecar ticket, the
  first restart rechecks that ticket without restarting a potentially healthy
  backend. If that recheck does not complete and you choose Restart again, or
  no current ticket exists, Desktop asks its bounded supervisor to restart the
  sidecar. If a durable service owns the home, or no sidecar is owned, it
  re-establishes the local recovery screen, which opens once the app has
  loaded; it does not start or restart the durable service.
- **Quit** closes the desktop app if that startup is still waiting. It does
  not reset data or remove a service.
- **Keep Waiting** closes the message and lets startup continue; the message
  returns later (30 seconds, then 60, then every 2 minutes) while startup is
  still waiting.
- After an unexpected exit, the supervisor can respawn the sidecar four times,
  after 1, 2, 4, and 8 seconds. The fifth counted exit is terminal and reports
  failure. An owned-sidecar restart resets that attempt count; a ticket-only
  recheck does not. Neither proves that the underlying cause is fixed. The cap
  and fail-closed classification are covered by the linked native-startup work.

If the message reappears after a restart, stop restarting blindly and
collect the bounded diagnostics below. A data-home schema error containing
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

From a checkout, `station doctor` checks local prerequisites and readiness.
The packaged CLI reports the selected endpoint, its reachability, saved
credential state and configured local service. Neither form inspects a Tauri
renderer or proves that a packaged window was shown. `station service
status --json` checks an installed user service and its identity endpoints. It
does not diagnose a Desktop-owned sidecar, and its failure does not by itself
explain a hidden window.

Keep shell and service logs separate:

| What you need | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Desktop shell log | `~/Library/Logs/<app-identifier>/station.log` | `$XDG_DATA_HOME/<app-identifier>/logs/station.log`, or `~/.local/share/<app-identifier>/logs/station.log` | `%LOCALAPPDATA%\<app-identifier>\logs\station.log` |
| Desktop shell panic record | `crash.log` beside `station.log` | `crash.log` beside `station.log` | `crash.log` beside `station.log` |
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
| Hidden release window, exact ticket, slow-start recovery, late reveal, restart, and activation deferral | Source configuration and pure Rust/UI test coverage associated with archive#3808 | **NOT_VERIFIED** on packaged macOS, Windows, and Linux shells |
| Hostile plugin IPC denial in a real Tauri WebView | Separate browser and real-WebView harnesses exist; the native lane was not run for this documentation review | **NOT_VERIFIED** here; historical gap recorded in [archive#2495](https://github.com/kontourai/station-archive/issues/2495) |
| Renderer/WebView death detection and bounded reload | Window recreation exists; no automatic renderer-death recovery or kill-the-WebView proof is established here | **NOT_VERIFIED**; [archive#2006](https://github.com/kontourai/station-archive/issues/2006) |
| EPIPE/closed-stdio handling | Server stdout guard and focused tests exist; no packaged closed-parent recovery journey was run here | **NOT_VERIFIED** on packaged shells; [archive#2006](https://github.com/kontourai/station-archive/issues/2006) |
| macOS Finder/Dock Apple Event launch panic diagnosis | The historical abort report does not establish a recoverable panic payload or current trigger. The shell now appends Rust panics to `crash.log`, and that recording is unit-tested, but no packaged abort has been observed producing an entry | **NOT_VERIFIED**; [archive#3496](https://github.com/kontourai/station-archive/issues/3496) |
| Tray rendering, tray activation, and second-launch behavior on release builds | Pure-state/static routing associated with [archive#3808](https://github.com/kontourai/station-archive/issues/3808) | **NOT_VERIFIED** on packaged macOS, Windows, and Linux |
| Mobile startup and recovery | Desktop readiness code is desktop-only; no equivalent mobile recovery evidence is supplied here | **NOT_VERIFIED** on Android and iOS; historical documentation scope in [archive#3817](https://github.com/kontourai/station-archive/issues/3817) |

The related implementation history is
[archive#3808](https://github.com/kontourai/station-archive/issues/3808). An
archived issue's status does not establish current implementation or release
qualification; use the owning source, tests and exact platform receipts.
