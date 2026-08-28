# Recover a desktop start

This guide is for a packaged Station desktop app that stays hidden while it
starts, shows **Station is not ready**, or opens but then cannot reach its
local service. It describes the recovery behavior implemented in the desktop
host; it is not evidence that every platform's packaged app has been exercised.
Contributor and operator evidence procedures are maintained separately from
this public guide.

## What a normal packaged start does

Stable, Beta, and Nightly configure their main desktop window to start hidden.
The window is revealed only after the desktop host has an exact sidecar
generation, instance ID, boot ID, and local API base, and the renderer has
checked that identity through the authenticated native transport. A renderer
commit must match that exact ticket; an old ticket cannot reveal a newer
sidecar.

This avoids showing a usable-looking window before its protected local surface
is ready. The native-startup work is tracked by [archive#3808](https://github.com/kontourai/station/issues/3808).

## When the window does not appear

After a 30-second startup epoch, the native host shows one **Station is not
ready** dialog with **Retry** and **Exit**.

- **Retry** starts a new epoch. If Desktop owns the local sidecar, it asks the
  bounded supervisor to restart that sidecar. If a durable service owns the
  home, or no sidecar is owned, it requests the renderer's recovery surface
  again; it does not start or restart the durable service.
- **Exit** closes the desktop app. It does not reset data or remove a service.
- After an unexpected exit, the supervisor can respawn the sidecar four times,
  after 1, 2, 4, and 8 seconds. The fifth counted exit is terminal and reports
  failure. A user-requested retry starts a new supervised attempt; it is not
  proof that the underlying cause is fixed. The cap and fail-closed
  classification are covered by the linked native-startup work.

If the dialog reappears, stop retrying blindly and collect the bounded
diagnostics below. A data-home schema error containing
`STATION_HOME_RESET_REQUIRED` is deliberately fail-closed: restart attempts do
not repair it. Follow the exact `station home reset` conditions only after you
have a backup and have selected the intended home.

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
| Desktop shell log | Use the installed app's Station log | Use the installed app's Station log | Use the installed app's Station log |
| Installed service log | `<STATION_HOME>/logs/<instance>-service.out.log` and `<STATION_HOME>/logs/<instance>-service.err.log` | `journalctl --user -u station-<instance>.service` (no service log file) | `<STATION_HOME>/logs/<instance>-service.log` |

The desktop shell honors `STATION_DESKTOP_LOG_LEVEL` set before launch:
`trace`, `debug`, `info`, `warn`, `error`, or `off`. Its file rotation is
bounded to five 5 MB files. The server logging configuration is maintained with
the installed app. Logs can contain local data or secrets; redact them before
sharing.

## Second launches and the tray

A second desktop launch, a reviewed deep link, and the macOS reopen event ask
the existing app to activate its main window. While that app is still waiting
for startup readiness, the request is deferred rather than directly revealing
the window. Once ready, the same reveal authority focuses it.

The tray is a different surface: it reports the currently selected local
backend. For an installed service it can offer service actions; for a
Desktop-owned sidecar it labels the built-in service and does not use service
controls. Neither a tray click nor a second launch proves that startup readiness
completed.

## Evidence limits and open platform work

The source and focused tests cover state transitions and browser-renderer
logic. The browser test for a hostile plugin is not an in-shell Tauri test;
browser or E2E success must not be presented as evidence that a real WebView,
native dialog, tray icon, or physical device behaved the same way.

| Behavior | Current evidence | Status |
| --- | --- | --- |
| Hidden release window, exact ticket, timeout, retry, and activation deferral | Source configuration plus pure Rust/UI tests from the archive#3808 work | **NOT_VERIFIED** on packaged macOS, Windows, and Linux shells |
| Hostile plugin IPC denial in a real Tauri WebView | Browser Playwright test attempts the hostile calls, but no in-shell harness exists | **NOT_VERIFIED**; tracked by [archive#2495](https://github.com/kontourai/station/issues/2495) |
| Renderer/WebView death detection and bounded reload | No desktop implementation or kill-the-WebView test is present | **NOT_VERIFIED**; tracked by [archive#2006](https://github.com/kontourai/station/issues/2006) |
| EPIPE/closed-stdio handling | No desktop/server EPIPE recovery proof is present | **NOT_VERIFIED**; tracked by [archive#2006](https://github.com/kontourai/station/issues/2006) |
| macOS Finder/Dock Apple Event launch panic diagnosis | A reported abort has no recoverable panic payload or confirmed trigger | **NOT_VERIFIED**; tracked by [archive#3496](https://github.com/kontourai/station/issues/3496) |
| Tray rendering, tray activation, and second-launch behavior on release builds | Pure-state/static routing from [archive#3808](https://github.com/kontourai/station/issues/3808) | **NOT_VERIFIED** on packaged macOS, Windows, and Linux |
| Mobile startup and recovery | Desktop readiness code is desktop-only; no equivalent mobile recovery evidence is supplied here | **NOT_VERIFIED** on Android and iOS; documentation scope tracked by [archive#3817](https://github.com/kontourai/station/issues/3817) |

The related native-startup implementation work is [archive#3808](https://github.com/kontourai/station/issues/3808). Consult the linked issues for live status rather than treating this table as a release checklist.
