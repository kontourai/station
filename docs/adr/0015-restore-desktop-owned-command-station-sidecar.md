# ADR 0015 — Desktop-owned Command Station sidecar without service attachment

**Status:** Accepted. Supersedes the station#1618 decision that Desktop is
only a client of an installed durable service. station#1987 restores
desktop-owned Command Station startup under the constraints recorded here.

## Context

Station Desktop must be usable on a clean local home before a user elects to
install an OS-managed background service. The prior #1618 doctrine made an
installed durable service the only Desktop target. That left first launch
dependent on an opt-in host integration and conflated two intentionally
different lifetimes.

## Decision

Desktop owns a loopback sidecar for its normal local launch:
`node <resource-dir>/dist-server/command-station.js`. A desktop-owned sidecar
dies with the app. A durable service intentionally outlives the app and is
never killed when the app quits.

Before it spawns, Desktop resolves one absolute `STATION_HOME` and reads that
home's registry through the packaged shared-registry bridge. No live
`type: 'service'` entry permits the atomic single-sidecar claim and spawn. One
live service entry reports that durable service as the home owner, including its
registered port, but does not spawn and does not set an API base from that port.
More than one live service is an explicit ambiguous repair state; it does not
spawn.

Attach-to-existing-service is deliberately out of scope. Four independent
security reviews found that the prior same-home proof's HMAC construction was
sound but its key escaped into agent-controlled subprocess environments. A
replayable bearer plus a nonce-bound HMAC cannot repair that trust boundary
while the shared secret is available to those descendants, so the capability
file, nonce protocol, proof response, and environment injection were removed
rather than patched. Desktop never programmatically trusts an unverified
loopback listener as its own backend. Opening a service a user installed is the
user's decision, not an automatic attachment.

Rust never reads or writes `instances.json` directly. A direct writer would
bypass the shared module's owner checks, atomic publish, and cross-process
mutation lock. Rust invokes the bounded Node bridge instead, leaving registry
semantics with `@kontourai/station-shared/instance-registry`. Before launch,
Desktop atomically claims a single `sidecar` slot through that same module; a
losing desktop never spawns a child.

The UI's **Run in background** choice is an opt-in native-host operation, not
a server API route: OS service installation is a native host privilege. The
packaged-desktop installer is currently **UNRESOLVED**. The existing
`service_action` is checkout/tsx-bound and cannot install from a packaged app.
Desktop therefore reports `canRunInBackground`, but offers no install control
until a reviewed packaged installer exists.

## Consequences

Desktop has one unified status source for the observed durable-service owner
and desktop-owned sidecars. The tray remains the sole writer of status events.
The sidecar is a second registry producer and consumer alongside the durable
CLI service; it does not weaken the registry's fail-closed ownership rules. A
sidecar becomes `Running` only after its registry upsert succeeds; failure
stops and reaps it. The supervisor is the sole registry publisher/remover, and
normal desktop exit waits for supervisor removal. The child receives its
supervisor PID and captured process-birth fingerprint. The watchdog probes the
actual PID/fingerprint (including Windows), with `ppid` retained only as a Unix
backstop. Abrupt desktop death is detected on the next 15-second poll, then
requests graceful shutdown and force-exits after 20 seconds; a starved server
event loop cannot provide a hard OS-level parent-death guarantee.

### NOT_VERIFIED

The following cannot be proven without real signed packaged builds:

- Resource-directory resolution to `dist-server/command-station.js` on signed
  macOS, MSI, NSIS, Linux, and AppImage; AppImage remaps resources.
- PATH-resolved `node` from Finder, Explorer, and desktop launchers.
- `Info.nightly.plist` actually injecting `STATION_DESKTOP_PORT=38141`.
- A real clean-home first launch reaching an interactive UI with no service
  installed.
- OS-level service install/handoff and reboot persistence.
- Tray delivery in a live webview.

The [2026-09-29 evidence addendum](#evidence-addendum-2026-09-29-2957)
records which of these items were later executed on packaged builds.

### Known test gap

The teardown idempotency guard (an `AtomicBool` swap) matters because a normal
quit fires both `WindowEvent::Destroyed` and `RunEvent::Exit`. Since #2961 the
ownership-gated half of teardown (`shut_down_owned_sidecar`) is separated from
the Tauri `AppHandle` and covered by a test that drives it against real child
processes: the owned sidecar is reaped, while a Service, Unowned, or None owner
signals nothing. The `AppHandle` wrapper (`teardown_sidecar`) and the tray kick
remain untested.

## Implementation note (#2961)

[ADR 0020](0020-distribution-two-trains-channels-as-pointers.md) D4 replaced
the read-then-claim sequence in the Decision above with one atomic host-owner
claim. The launch no longer decides ownership from a read: the shared module
refuses the sidecar claim while any live service or other sidecar holds the
home and returns that owner. A preparation safety read remains to leave a
serving home unprepared; it does not decide launch ownership. Even that path
claims atomically, releasing a won reservation without spawning if the service
exited meanwhile. The status refresh retains a display-only read that
re-derives a non-sidecar owner. Also, `service install` and the service
supervisor claim through the same primitive, so a live sidecar also blocks
them. Installation reserves the home and writes policy before backend startup;
backend failure restores the prior entry. Without installed policy, the
supervisor creates its own service owner record with PID/birth before start.
A conflicting live owner keeps it alive without running Station, polling with
backoff capped at 30 seconds and logging reason changes. Lost ownership at
readiness or on an existing five-second health tick stops and reaps Station
before the same wait. Recovery waits for a live replacement even at the same
service id, and retraction checks both PID and birth. A tick read that is
unreadable keeps Station running and retries next tick; only a successful
read proving a missing or different owner triggers recovery. An unreadable
startup claim still fails closed.
Desktop records the child's PID/birth immediately after spawn, before Listening,
so stale recovery retains a live orphan. Spawn and publication are still
separate operations. Bare container `service run` self-claims a fresh home;
direct `command-station.js` remains unfenced, including a container invoking
it directly and exposing a `0.0.0.0` listener through published ports. The service-owner report, no automatic attachment, and the lifetime
split are unchanged.

## Evidence addendum (2026-09-29, #2957)

This addendum records packaged-build runs against the NOT_VERIFIED list above.
It does not change the decision. **EXECUTED** means the result was observed on
the named build; **NOT_VERIFIED** means no run established it.

### Builds and hosts

- **macOS:** `nightly-desktop` asset
  `station-0.1.11-nightly.2463.2-macos-aarch64.app.tar.gz` (SHA-256
  `e2527e5cb38be4cc219c258ba9beb5c270128b7b3bba9406863d7ca76e4d4cb7`). It was
  built from `0690c93997c7` at 2026-09-29T12:47:27Z and run on macOS 26.7
  arm64. `codesign` reports Developer ID Application (team `U7KHF2QAC4`);
  `spctl` reports `accepted, source=Notarized Developer ID`; the ticket is
  stapled. The bundle ran from an unpacked copy, not `/Applications`.
- **Windows:** `nightly-desktop` asset
  `station-0.1.11-nightly.2463.2-windows-x86_64-setup.exe` (SHA-256
  `957d2bd6fdfba0ab4f97f75752e8a07ba76f3f39ec64a9bc3a1757703f061a6d`). It was
  installed per-user with `/S` on Windows 11 Pro x64. **This installer is not
  Authenticode-signed** (`Get-AuthenticodeSignature`: `NotSigned`): the
  nightly signs Windows only when a certificate secret is configured. Every
  Windows result below is therefore an unsigned-build result.
- **MSI, Linux (deb/rpm), and AppImage:** no such artifact has been published.
  Only the tagged release workflow builds them, and no tagged release has
  completed (#1243).

Except where a row says otherwise, each run used an isolated, empty
`STATION_HOME`. macOS runs launched through LaunchServices (`open`). Windows
runs launched through an interactive-session scheduled task. Only the
PATH-resolution runs scrubbed the launch environment; the other runs
inherited the launching shell's environment. The claims rest on the author's
retained run logs, process listings, and screenshots. Those are not
published, because they contain local paths and unrelated desktop content.

### Results

| NOT_VERIFIED item | macOS (signed, notarized) | Windows NSIS (unsigned) |
| --- | --- | --- |
| Resource-directory resolution | **EXECUTED**: sidecar ran `<bundle>/Contents/Resources/dist-server/command-station.js` | **EXECUTED**: sidecar ran `%LOCALAPPDATA%\Station Nightly\dist-server\command-station.js` |
| PATH-resolved `node` from GUI launchers | **EXECUTED** for `open` with a scrubbed environment (`PATH=/usr/bin:/bin:/usr/sbin:/sbin`), a proxy for Finder and Dock: the login-shell probe recovered a version-manager `node`. A Finder or Dock launch itself is NOT_VERIFIED. The rejection path is **EXECUTED**: a login shell reporting a node-free PATH produced the "Check that Node 24 is installed" dialog, started no backend, and exited only on **Exit** | **EXECUTED** for a scheduled-task launch (registry-derived user environment): `node` resolved to the version manager's `node.exe`. Explorer is NOT_VERIFIED: that launch used the default root and was refused before any `node` lookup (see findings) |
| `Info.nightly.plist` port injection | **EXECUTED**: in the scrubbed-environment run, the launch environment had no port and the app process carried `STATION_DESKTOP_PORT=38141` and `STATION_DESKTOP_CHANNEL=nightly` from `LSEnvironment`. The listener port alone cannot prove this, because the channel default is also 38141 | Not applicable (no plist). The generated channel default placed the sidecar on 38141 |
| Clean-home first launch reaches an interactive UI | **EXECUTED**: empty home, sidecar claim, registry `type: sidecar` upsert, interactive Home view. Quit reaped the sidecar and emptied the registry | NOT_VERIFIED (UI not observed; the console session was covered by a full-screen shell). Native readiness epoch 1 timed out at 30 s. The sidecar's first ticket arrived about 51 s after its claim, when the epoch had already failed (`phase=Failed`). Server logs show pairing requests from about 51 s, then event streams and focus reports from about 68 s. The log does not attribute their origin, so a late UI recovery is plausible but unconfirmed |
| OS service install/handoff | **EXECUTED** with a nightly portable install and `station service install --instance=<test>` against a desktop-initialized home: a live `type: service` entry made the desktop spawn no sidecar, and quitting the desktop left the LaunchAgent's process running. The tray showed `Status: Not installed`. It only reports a service bound to a saved profile, and this run never bound one (`station setup local` was not run; the home's `local` profile still named the earlier sidecar). That stale profile pointed at the service's port, and the service refused its credential ("approval needed"). The desktop's service-owner status text was not observed, so reporting the owner is NOT_VERIFIED | NOT_VERIFIED |
| Reboot persistence | NOT_VERIFIED (no reboot was run). Proxy, **EXECUTED**: `launchctl bootout` then `bootstrap` of the installed plist brought the service back on its port without a kickstart (`KeepAlive=true`; no `RunAtLoad` key) | NOT_VERIFIED |
| Tray delivery in a live webview | **EXECUTED**: the status menu showed `Status: Running · Local server: built into desktop app`; its **Connections…** item navigated the live webview from Home to Connections | NOT_VERIFIED |
| MSI, Linux, AppImage (all items) | NOT_VERIFIED: no artifact exists (#1243) | NOT_VERIFIED |

### Findings outside the original list

- **Abrupt desktop death.** On Windows, the sidecar watchdog logged the
  missing supervisor about 14 s after the kill, measured from the sidecar's
  last client-stream close because the log has no kill timestamp. Graceful
  shutdown then logged a provider-adapter cleanup failure. The test script's
  own clock found the process still alive 91 s after it issued the kill. The
  final log line came about 100 s after detection, not within the 20 s
  force-exit this ADR records. On macOS, the
  same `kill -9` test ended the sidecar 7 s after the kill. On both platforms,
  the dead desktop's `type: sidecar` registry entry remained afterwards,
  because only the supervisor removes it. Whether the next launch recovers
  that entry is NOT_VERIFIED. All of these are single runs.
- **Shared roots without saved metadata refuse first launch.** A shared root
  containing only earlier `instances/dev` homes, or a portable-install root,
  refuses first launch with "saved Station metadata is missing from an
  initialized or in-progress shared root; restore profiles.json". On Windows
  that refused launch still created an empty `config` directory in the root.
- **Discarded runs.** Two early macOS no-node runs exited while the refusal
  dialog was showing, with no dismissal by the author. Other local sessions
  were operating Station on the same machine at the time, and the cause was
  not determined. An isolated re-run held the dialog for more than 20 s, and
  it exited only after **Exit**. The two early runs are not counted as
  evidence.

## References

station#1618, station#1987, station#1672, and
[Instance Registry](../design/instance-registry.md).
