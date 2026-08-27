# Desktop tray

Station's desktop shell presents a native menubar/tray item for its own local
runtime. It reads shared, secret-free saved-Station metadata from
`$STATION_ROOT/config/profiles.json`, selects the unique local entry whose
`localService.baseDir` owns this Desktop channel's admitted `STATION_HOME`, and
then validates that runtime's exact `service/<instance-id>.json` manifest. It
never guesses from `service/default.json`, filename order, or the shared global
default, so selecting another channel or a remote Station cannot retarget tray
service actions. For a Desktop-owned sidecar, it reports the built-in backend
but does not offer service controls. Startup
recovery and its evidence boundary live in [Recover a desktop
start](../user/native-recovery.md) and [Native shell
verification](native-shell-verification.md).

## Health states

| State | Meaning | Poll cadence | Actions |
| --- | --- | --- | --- |
| Not installed | No valid service manifest is available | 60 seconds | Open, Start, and Stop disabled |
| Stopped | Both installed-service identity probes explicitly refused a connection | 30 seconds | Start |
| Running | Both identity endpoints returned 200 with the manifest instance ID | 10 seconds | Stop, Open Station UI |
| Unhealthy | A timeout, DNS/error, partial response, non-200 response, or identity mismatch occurred | 10 seconds | Start, Stop, Open Station UI |

The tray reads `/api/system/identity` on the manifest server port and
`/__station/identity` on the manifest UI port. It intentionally gives a
conservative health display: it verifies the instance ID but does not replace
the CLI's full SHA/boot-ID health proof. Use `station service status --json` as
the authoritative diagnosis.

The running, stopped, and unhealthy tray silhouettes are embedded PNG template
assets. macOS decodes the dedicated `@2x` variants for a sharp menubar icon;
Linux and Windows decode the matching 1x variants. Menu and icon mutations are
marshalled through Tauri's main thread.

## Actions and CLI parity

Open Station UI uses the owned runtime manifest's UI port. Start and Stop run the
installed checkout's absolute Node, `tsx`, and `scripts/station-cli.ts` paths
with an explicit PATH; the desktop process never trusts a GUI-launcher PATH.
The equivalent terminal commands are:

```bash
station service start --json
station service stop --json
station service status --json
```

On macOS, Start bootstraps an unloaded LaunchAgent and then uses
`launchctl kickstart -k`; Stop uses `launchctl bootout` so `KeepAlive` cannot
immediately relaunch it. Linux uses `systemctl --user start|stop`. Windows
retains a compile-safe observable tray surface, but Start and Stop remain
disabled until Station supports a Windows user-service backend.

After Start or Stop, the tray performs an immediate refresh followed by three
two-second convergence polls before returning to its normal cadence.

## Manual tray checklist

Run this on a release build from an installed checkout; do not use the bundled
desktop server as the target.

1. Install a user service and launch the desktop shell. Confirm the initial tray state reaches Running within one 10-second poll interval.
2. Choose Open Station UI and confirm the browser opens the owned runtime manifest's UI port, not another channel's UI port.
3. Choose Stop. Confirm the tray moves through Stopped, `station service status --json` reports the unit inactive, and a macOS service does not relaunch through KeepAlive.
4. Choose Start. Confirm the service becomes Running, UI opens successfully, and `station service status --json` is healthy.
5. Change the manifest to an unreachable or mismatched endpoint in a disposable service home. Confirm the tray shows Unhealthy rather than Stopped.
6. On macOS, repeat Stop/Start after unloading the LaunchAgent and record that Start bootstraps then kickstarts it; record the menubar icon rendering at native scale.
7. On a supported Linux desktop, repeat steps 1–5 and record the tray implementation/environment result. Linux indicator support is best-effort across desktop shells; document a missing indicator as a limitation, not a passing verification.

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

## Logging (#1899)

The native shell (Rust/Tauri process — the tray, the notification watch, the
credential/profile bridge, `bundled_server_status`) logs through
[`tauri-plugin-log`](https://github.com/tauri-apps/plugins-workspace), not
`eprintln!`. A terminal launch still sees stdout; a double-clicked `.app` — the
common case a bare `eprintln!` never reaches — gets a durable file instead.

**Where the file lives** (Tauri's own `app_log_dir()` convention):

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Logs/io.kontourai.station/station.log` |
| Linux | `~/.local/share/io.kontourai.station/logs/station.log` (or `$XDG_DATA_HOME` if set) |
| Windows | `%LOCALAPPDATA%\io.kontourai.station\logs\station.log` |

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

**Rotation**: bounded to 5 files of up to 5MB each (a 25MB ceiling) —
`RotationStrategy::KeepSome(5)` renames the previous file with a date suffix
on rotation rather than growing or deleting silently.

For a hidden-window timeout, a sidecar failure, or a distinction between this
shell log and service/server logs, use [Recover a desktop
start](../user/native-recovery.md). Logs are diagnostic evidence, not proof
that native chrome was displayed or that a renderer recovered.
