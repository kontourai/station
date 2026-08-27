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

### Known test gap

The teardown idempotency guard (an `AtomicBool` swap) and its service-mode
early return are correct by construction but have no direct test: driving them
requires a Tauri `AppHandle`. The guard matters because a normal quit fires
both `WindowEvent::Destroyed` and `RunEvent::Exit`. The reachable half is
covered by a test that spawns two real children and proves the owned sidecar is
reaped while an attached service is not signalled.

## References

station#1618, station#1987, station#1672, and
[Instance Registry](../design/instance-registry.md).
