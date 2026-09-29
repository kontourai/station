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

The teardown idempotency guard (an `AtomicBool` swap) and its service-mode
early return are correct by construction but have no direct test: driving them
requires a Tauri `AppHandle`. The guard matters because a normal quit fires
both `WindowEvent::Destroyed` and `RunEvent::Exit`. The reachable half is
covered by a test that spawns two real children and proves the owned sidecar is
reaped while an attached service is not signalled.

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

Each run used an isolated, empty `STATION_HOME`, launched through
LaunchServices (`open`) or an interactive-session scheduled task. Neither
inherits the operator's shell environment. Screenshots are not committed
because they capture unrelated desktop content.

### Results

| NOT_VERIFIED item | macOS (signed, notarized) | Windows NSIS (unsigned) |
| --- | --- | --- |
| Resource-directory resolution | **EXECUTED**: sidecar ran `<bundle>/Contents/Resources/dist-server/command-station.js` | **EXECUTED**: sidecar ran `%LOCALAPPDATA%\Station Nightly\dist-server\command-station.js` |
| PATH-resolved `node` from GUI launchers | **EXECUTED**: app launched with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`; the login-shell probe recovered a version-manager `node`. The rejection path is also **EXECUTED**: a login shell reporting a node-free PATH produced the "Check that Node 24 is installed" dialog, started no backend, and exited only on **Exit** | **EXECUTED** for a scheduled-task launch (registry-derived user environment): `node` resolved to the version manager's `node.exe`. An Explorer launch was made but refused earlier (see findings) |
| `Info.nightly.plist` port injection | **EXECUTED**: with no port in the launch environment, `LSEnvironment` supplied `STATION_DESKTOP_PORT=38141` and the sidecar listened on 38141 | Not applicable (no plist). The generated channel default placed the sidecar on 38141 |
| Clean-home first launch reaches an interactive UI | **EXECUTED**: empty home, sidecar claim, registry `type: sidecar` upsert, interactive Home view. Quit reaped the sidecar and emptied the registry | **Did not reach it.** Readiness timed out at 30 s; the sidecar's first ticket arrived at about 51 s, after the epoch had failed (`phase=Failed`). The UI was not observed (the console session was covered by a full-screen shell) |
| OS service install/handoff | **EXECUTED** with a nightly portable install and `station service install --instance=<test>` against a desktop-initialized home: a live `type: service` entry made the desktop spawn no sidecar, and quitting the desktop left the LaunchAgent's process and listener running. **Did not match the decision text:** the tray reported `Status: Not installed` and `Service unavailable` instead of the service as home owner | NOT_VERIFIED |
| Reboot persistence | NOT_VERIFIED (no reboot was run). Proxy, **EXECUTED**: `launchctl bootout` then `bootstrap` of the installed plist restarted the service without a kickstart (`KeepAlive=true`; no `RunAtLoad` key) | NOT_VERIFIED |
| Tray delivery in a live webview | **EXECUTED**: the status menu showed `Status: Running · Local server: built into desktop app`; its **Connections…** item navigated the live webview from Home to Connections | NOT_VERIFIED |
| MSI, Linux, AppImage (all items) | NOT_VERIFIED: no artifact exists (#1243) | NOT_VERIFIED |

### Findings outside the original list

- **Abrupt desktop death on Windows.** The force-killed desktop's sidecar
  watchdog detected the missing supervisor about 14 s after the kill, and the
  listener closed. Graceful shutdown then logged a provider-adapter cleanup
  failure. The process exited about 100 s after detection, not within the
  20 s force-exit this ADR records. On macOS, the same `kill -9` test ended the
  sidecar 7 s after the kill. Both are single runs.
- **Shared roots without saved metadata refuse first launch.** A shared root
  containing only earlier `instances/dev` homes, or a portable-install root,
  refuses first launch with "saved Station metadata is missing from an
  initialized or in-progress shared root; restore profiles.json". On Windows
  that refused launch still created an empty `config` directory in the root.
- **Launch attribution.** Two early macOS no-node runs appeared to exit while
  the dialog was showing, and another local session was operating the same
  nightly bundle identifier at the time. An isolated re-run held the dialog
  for more than 20 s, and it exited only after **Exit**. Those early runs are
  not counted as evidence.

## References

station#1618, station#1987, station#1672, and
[Instance Registry](../design/instance-registry.md).
