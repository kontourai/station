# Native shell verification

This contributor and operator guide separates source inspection, browser
results, packaged-shell behavior, and physical-device evidence for native
startup, credential and transport boundaries, request queues, relay link intake,
and desktop recovery. It is intentionally not admitted to public Pages: it names
implementation seams and verification boundaries rather than providing an
end-user recovery path. Use [Recover a desktop start](../user/native-recovery.md)
for that public path.

## Build a development iOS simulator app

On an Apple Silicon Mac with Xcode and an installed simulator runtime:

```sh
npm run dependencies:ci
npm run build:ios:simulator
```

The command initializes and builds with `tauri.ios.dev.conf.json`, giving the
app the separate `io.kontourai.station.dev.instance` identifier and matching
`station-dev-instance` pairing scheme. The additional development Info.plist
retains Station's privacy descriptions and its pairing association when the
Xcode project is regenerated. The native app build owner adds the separate
`station-relay-dev-instance` association to iOS; Android does not register that
relay-secret receiver.

XcodeGen can regenerate Info.plist without URL associations while Cargo reuses
the deep-link plugin's cached build script. Station's Rust build script reads
the active Tauri deep-link channel, restores its exact pairing scheme when
missing, rejects a mismatched or ambiguous association, then adds the matching
relay scheme. The hosted stable iOS build and each TestFlight channel must
verify the generated pairing and relay associations independently.

The build embeds the simulator's application and private keychain group in
the executable's `__TEXT,__entitlements` section using simulator-only linker
settings. These iOS rights must not be put in the macOS code signature of the
simulator process. The verifier reads the actual section bytes, checks the
app identity, exact pairing and relay schemes, and simulator platform, then seals resources
with an ordinary ad-hoc signature. It refuses device or non-development
artifacts. This requires no distribution certificate and does not produce a
device, TestFlight, or App Store package. The command prints the resulting
`.app` path. Archive that app only for a workspace or service that accepts iOS
simulator artifacts; it cannot be installed on a physical iPhone or iPad.

## Qualify native relay link intake

The [iOS intake implementation](../../src-desktop/src/native_relay_ios_launch.rs)
wraps public application/scene delegate callbacks before generic URL parsing;
the [host custody owner](../../src-desktop/src/native_relay_link_intake.rs)
emits public metadata and opaque handles only. An iOS source check includes
those platform branches; a desktop Rust test does not compile the callback
module. Neither check proves installed delivery or OS storage.

Qualification requires the same installed app identity, channel and actual
proof-key surface as the operator-approved native v2 invitation. Exercise
cold and warm launches, explicit cancel then return to the original invitation,
wrong channel/surface/scope, expiry and replay through the mounted intake.
Exercise pairing cold/warm parity and app-unavailable recovery separately.
Check a malformed relay carrier with a sentinel against app logs, renderer
events, telemetry, notifications and persistent route storage; do not infer
that OS-owned URL objects were erased.

The native grant backend uses the same
[maintained secure-entry adapter](../../src-desktop/src/native_secure_entry.rs)
as native proof custody. On the installed iOS client, observe grant status
before redemption, accepted grant write/readback, exact retirement/cleanup,
then status after deletion. Missing records and unavailable/locked storage must
remain distinct. Retain the artifact SHA, app identity and native evidence;
an in-memory backend or host typecheck cannot qualify mobile custody.
A warm invitation review uses a separate query client from **Your Stations**.
Qualification must confirm that Station confirmation, redemption and cleanup
refresh the existing card after dialog dismissal, including uncertain and late
replies, without remounting the application or changing its selected Station
and account session. The refresh hint is profile metadata only; visible status
still comes from a fresh validated native-host read. Mounted UI tests establish
this frontend boundary, not installed iOS qualification.
Before linked redemption, optional connection troubleshooting can classify a
refused grant-status response as shape, profile, route, ambiguous, scope,
metadata or cleanup. Unrecognized invoke failures report `unknown`; the existing
fixed host status refusal reports `unavailable`. These are closed diagnostic
codes, with no response bodies or raw error text. The adapter still rejects
multiple grants and foreign or malformed metadata; it never chooses a grant
to make qualification proceed.

Before linked redemption, even one saved grant blocks
redemption and keeps the invitation available for explicit cleanup. Multiple
saved grants and pending cleanup also expose recovery. **Review saved
connections** opens a management-only preview for the same saved route and
installation. **Remove saved connections** is the explicit confirmation.
Technical routing details stay collapsed until opened. Operational status still
refuses multiple grants. Confirmation first tries normal retirement at the
broker, then quarantines eligible local routing records under the profile
revision. It does not redeem the invitation or alter Station trust, Device
approval, account sign-in or shared Project access.

Cleanup first attempts normal individual retirement. For an older generation
only, the native host may authenticate a superseded-scope observation with the
unconsumed bound invitation and its installation proof key. The journal records
this distinct scope basis before exact local deletion. It does not claim that
an individual grant was found or revoked. Profile, pending-link, trust, key and
vault identity changes after the request refuse deletion. Unavailable or
unsupported brokers, failed storage and equal/future generations remain pending.
If device setup encounters ambiguity after redemption, its fixed diagnostic is
`native_enrollment_saved_connections_ambiguous`; it directs the user to a fresh
owner-issued invitation for review and cleanup. A consumed invitation cannot
be reused as cleanup authority. Same-generation custody is not automatically
removed. Qualify the single-old-grant turnover, preview, explicit confirmation,
pending status, restart recovery and replacement preservation in the installed
shell before claiming this journey.

## Native request queue pressure

The authenticated native HTTP bridge admits up to 8 ordinary requests and 12
requested event streams per origin, with 32 active requests across origins.
Ordinary requests wait in a bounded FIFO of 64 entries. The reserved identity
health probe has a separate allowance. These are request counts, not CPU,
memory, provider usage, or rate-limit measurements.

A full ordinary queue rejects admission before sending HTTP bytes. That
`transport_capacity` error includes a validated `capacity` snapshot: waiting
and active counts and limits, ordinary and stream counts for the requested
origin, and a 250 ms retry hint. The same counts appear in its human-readable
diagnosis. The snapshot also lists active request methods, fixed route
categories, ages, phases (awaiting response or receiving a body/event stream),
and whether they target this Station, plus the FIFO head's age and category.
The summary prioritizes the oldest ordinary requests before long-lived event
streams. Up to three active entries and the queue head appear in the
human-readable error and a shell warning, emitted at most once per five
seconds. Categories
omit full URLs, query strings, credentials, request bodies, and resource IDs.
Counts describe the moment of refusal; request ages include admission wait.
They do not establish whether the server or client caused the backlog.

The renderer retains the request and automatically retries this pre-dispatch
queue refusal up to six times. Delays start at 250 ms, double to a 4-second
cap, and add up to 25% jitter (about 12–15 seconds total back-off). Each attempt
checks current admission under the host's queue lock. Cancellation stops
back-off, and the captured authority is checked again before each retry.
Request body, method, URL, and scoped binding remain the same.

Stream, reserved health-probe, duplicate-ID, legacy uncoded, and post-dispatch
channel failures do not use this retry path. This prevents a possibly sent
chat POST from being replayed. After exhaustion, the final error retains the
latest counts and explains that automatic retries could not find space.
React Query still does not retry `transport_capacity`, so it cannot start a
second automatic retry cycle after the transport's bounded attempt.

Rust admission tests cover the serialized snapshot and queue bound; the
native adapter tests cover recovery, exhaustion, cancellation, authority
changes, and non-replayable failures. Those tests do not establish real
WebView IPC, packaged-shell, mobile, or physical-device behavior.

## Native foreground dispatch deadlines

The native HTTP broker waits up to 60 seconds for response headers on
foreground chat POSTs: `/api/orchestration/chat`, its `delegated` and
`background` variants, and `/api/orchestration/chat/:conversationId/continue`.
These routes wait for provider-turn acceptance before responding. Ordinary
requests retain their 20-second header deadline; SSE response bodies remain
open-ended. Cancellation still fences late responses and uses the existing
bounded orphan allowances. SDK deadlines remain a separate boundary.

The explicit desktop proof uses the real WebView, IPC and native HTTP transport
against an authenticated fixture that delays the chat receipt for 26 seconds:

```sh
npm run test:tauri-shell -- --build --lane=native-chat-dispatch
```

The fixture uses the WebDriver credential store and a synthetic provider-turn
receipt. It proves transport timing on the exercised macOS debug shell, not
real provider dispatch, OS keyring custody, mobile behavior or release signing.
The Rust suite separately checks delayed foreground and ordinary exchanges.

## What can run today

For the native relay-key approval ceremony on macOS, run the explicit shell
lane from a disposable worktree:

```sh
npm run test:tauri-shell -- --build --lane=native-relay-key-approval
```

The lane starts an isolated Desktop home and loopback broker, uses the real
WebView and macOS Keychain, receives a Station-signed candidate, enters the
operator's comparison code and full key ID, then approves and revokes the
public trust record. It removes only its generated Keychain accounts and
fixture home. The lane is opt-in because it needs an unlocked user Keychain;
the default shell sweep still runs its existing two lanes. A successful run
proves the pre-grant key ceremony on the exact macOS debug bundle exercised.
No such run is claimed by this documentation review. It does not prove a Pion
application route, account/Device continuation, a second person or machine,
release packaging, or hosted deployment.

Desktop and mobile also start a saved-route grant-renewal supervisor from
[`ApiBaseProvider`](../../src-ui/src/contexts/ApiBaseContext.tsx). It checks
host-owned grant status, renews existing grants while the app is visible, and
rechecks on focus, visibility and online events. It does not approve a new
route or make that route available for application work. More than 64 saved
routes pauses renewal for all routes; removing routes lets supervision resume.
The host persists the renewal intent before the broker request so a lost reply
can be recovered with the same renewal ID, and checks the saved profile revision
again before accepting the result.

The explicit `native-relay-diagnostic-echo` shell lane exercises that desktop
supervisor through a lost renewal reply, then checks stale-revision rejection
and the diagnostic transport. It uses a real main WebView and fixture-owned
Keychain accounts, plus loopback broker, coturn and Pion fixtures. The adapter
and supervisor unit tests use injected boundaries. Neither their passing result
nor the existence of the shell lane establishes a completed native run here.
Mobile background renewal and packaged-platform acceptance remain separate.

### Relay-management source integration

The Connections [operator panel](../../src-ui/src/views/connections-hub/RelayOperatorPanel.tsx)
is mounted in desktop and selected native relay views. It supports setup-link
copy, exact installation approval/revocation, single-use invitation issuance,
and pending account-bound Device approval/denial. Native Project access controls
are visible only with `manage-members`; writes also require management or
operate scope. `relay:manage` is explicitly operator-promoted, not a default or
preset grant, and never substitutes for Project IAM.

The [native account owner](../../src-desktop/src/native_account_operations.rs)
and [SDK continuation](../../packages/sdk/src/client/application-session-native.ts)
prepare management POSTs through a dedicated bounded host operation. The generic
read operation remains GET/HEAD only. The server route and authority owners
recheck the actual actor, provider currentness and target approval after awaits.
Full Project invitation links are accepted as token input without changing the
selected Station.

This records inspected source integration, not a completed native delivery.
The mounted server/account/native-proof composition suite at `07a7d02ff0`
has an executed 35/35 receipt and maintained fault/restoration controls. It uses
controlled peer transport and an external broker stub, with real account/proof
checks and surface-registry effects. Device approve/deny coverage is admission
only (`503 enrollment_unavailable`), not an enrollment-decision result. It does
not exercise Rust IPC, a native shell or physical delivery.
The account-bound gate now admits exact native relay-management leaves with
current Device/account proof and separate management scope; credential-only
account-bound Devices remain refused. This inspected source change does not
turn a composition keeper into native runtime qualification. Existing simulator
records for #3114, #3190 and #3199 remain evidence of their own earlier journeys;
they do not qualify these new operator controls. Released Nightly, physical
iOS/Android, process-lifecycle and two-human operator/recipient verification
remain **NOT_VERIFIED** for this delta.

### Native protected Project pilot

The explicit macOS development lane is:

```sh
npm run test:tauri-shell -- --build --lane=native-project-proof
```

The [shell selector](../../scripts/run-tauri-shell-e2e.mjs) uses the separate
WebDriver relay-grant app identity. The lane needs an unlocked macOS Keychain,
Docker with the pinned coturn image, the pinned Go toolchain and cached Pion
modules, and OpenSSL. It is a manual lane; the default shell sweep does not run
it. Its debug build does not qualify a signed release artifact.

The [runtime fixture](../../tests/tauri-shell/native-project-runtime-fixture.ts)
starts the real StationRuntime, local account provider, broker, TURN and Pion
connector in private fixture homes on allocated non-default ports. It preserves
the same Station identity when restarting with one exact native client surface
and the explicit Device-proof pilot. Real account login and invitation
acceptance install an active Viewer membership, which the operator API verifies
before account-bound Device pairing. Registration alone does not install that
membership. The native host owns the pairing bearer, routing grant and distinct
Device/account keys; the WebView supplies no fabricated principal or Device
metadata.

The [driver](../../tests/tauri-shell/native-project-acceptance.e2e.ts) and
[main-WebView runner](../../tests/tauri-shell/native-project-acceptance-webview.ts)
check operator-approved Device binding and host self-receipt,
host-owned peer preparation and signing, native account challenge/exchange,
protected Project read and reconnect through the application channel, and
subsequent account and Device revocation. Selected relay pairs and a browser direct-Project
request counter distinguish the exercised transport. Direct loopback bootstrap
is still used for trust, pairing and the host receipt; this is not fresh
relay-only enrollment.

On September 30, 2026, the macOS debug lane completed against frozen harness
revision `d468df79564510e9df72e3b19da7d36a89ac41e0`. The retained
`tauri-shell-final-d468df795.txt` log records the current host self-receipt,
real Keychain Device key, active Viewer membership and native challenge/exchange
responses with status 200. The protected shared-Project read and reconnect
returned 200; account revocation returned 401; reauthentication restored a 200
read; revoking the paired Device returned 403 with no Project payload. The run
observed nine selected relay pairs, fresh request peer handles and zero browser
direct-Project requests, and completed its fixture-owned cleanup checks.

The exercised debug executable has SHA-256
`baa3dee2f882354be1f55f2ffbcaaaf8163eb75bd2872e3cdc507eaff67d767b`;
its embedded build/client revision is `d7f19eeda`. The harness revision is
recorded separately because its later changes were confined to the Node child
launcher and fixture/driver files; production Rust, SDK, UI and proof sources
were unchanged between those revisions.

This is executed real WebView/IPC/Keychain and local-provider evidence for that
development bundle and frozen harness. It does not establish signed release
provenance or all-platform qualification. Later binaries and source changes need
their own receipt.

After merging the updated server runtime, the same debug executable completed
the lane again at frozen Station/runtime and harness revision
`a612b6df46e494c7905cfcb2579d402922db9246`. The retained
`native-project-main-merge-tauri.log` ends with `TAURI_LANE_EXIT_CODE=0` and
records the same 200/200/401/200/403 read, reconnect, account revocation,
reauthentication and Device revocation sequence. It again observed nine selected
relay pairs, zero browser direct-Project requests, current host self-receipt and
successful fixture-owned cleanup. The binary/build identity above remains
separate from this later server/runtime revision; this rerun does not broaden
the platform, deployment or onboarding qualification.

Cleanup targets only generated fixture homes, owned processes/containers and
exact Keychain service/account owners. Device and account proof-key owner hashes
use raw UUID bytes; candidate-record and credential metadata hashes use their
string fields. Unverified cleanup is a failure, and retained artifacts
are not permission to delete unrelated Keychain entries.

This dated manual lane does not establish later ordinary native route/sign-in
UI, and does not qualify mobile,
Windows/Linux, packaged release use, remote internet connectivity, production
TURN/TLS, external identity providers or two-person collaboration.

The separate hostile-plugin lane also runs in a real Tauri WebView:

```sh
npm run test:tauri-shell -- --build --lane=plugin-host-security
```

[`scripts/run-tauri-shell-e2e.mjs`](../../scripts/run-tauri-shell-e2e.mjs)
selects [`tests/tauri-shell/plugin-host-security.e2e.ts`](../../tests/tauri-shell/plugin-host-security.e2e.ts).
Its isolated fixture checks that the host has Tauri internals while a hostile
cross-origin plugin frame has no own bridge and cannot reach the parent's
bridge, storage or DOM. It also checks blocked network/API destinations and
navigation containment. The default sweep runs this lane and `device-pane`;
the key-approval and grant-lifecycle lanes are explicit opt-ins. Harness
availability is source evidence, not an executed platform result. Record the
exact binary, revision, host and completed lane result when running it.

Run the changed selector first, then the exact focused checks it selects:

```sh
npm run test:changed -- --base=origin/main --explain
npm run test:focused -- scripts/__tests__/startup-readiness-static.test.ts
npm run verify:desktop-rust
```

The static test pins release-channel hidden-window configuration and the one
native reveal authority. The renderer does not commit startup readiness; the
native shell requests that commit itself. The Rust lane
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
remove the native consent override on this evidence; the in-shell
harness is separate from the browser spec. Its historical absence was recorded
in [archive#2495](https://github.com/kontourai/station-archive/issues/2495);
the real-WebView lane above now exists. Neither its existence nor a browser
pass qualifies a release-shell sandbox or authorizes removing that override.

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

The startup state owner is
[`src-desktop/src/startup_readiness.rs`](../../src-desktop/src/startup_readiness.rs):
application content may reveal only after two independent prerequisites converge.
Tauri's native page-start callback observes the exact main WebView and permits
the host to begin its authenticated ticket proof; a post-React-layout mount
commit from that main WebView proves renderer liveness. Page start alone is not
renderer readiness. The ticket still binds the current generation, instance
ID, boot ID, and API base. Native bootstrap retains and replays page/mount facts
that arrive before desktop readiness state exists, so the eager mount is not a
browser retry loop. For an owned sidecar, the native host performs the
authenticated local identity proof and rechecks both the saved profile binding
and current ticket before committing it. Native page-start/ticket callbacks
request that proof; the renderer reports its mounted tree separately and does
not drive the startup identity check. For a service-owned or unowned
backend, a recovery-surface commit can admit the mounted shell without a
sidecar ticket. This establishes recovery UI readiness, not backend availability.

The native host arms a 30-second deadline for each epoch. If readiness is still
waiting, it normally shows Retry/Exit once. A pending activation instead starts
another readiness epoch; activation after failure also resumes readiness.
An owned sidecar with a current ticket gets one non-disruptive reprobe. If that
does not settle and another retry follows, or there is no current ticket,
the host requests an owned-sidecar restart. A non-owned backend receives a
recovery-surface recommit, never a durable-service restart. These effects are
routed by [`src-desktop/src/lib.rs`](../../src-desktop/src/lib.rs).

On macOS, pending activation may present a native-owned cover so the WebView
can render while the proof proceeds. Application content remains covered until
identity and mount readiness converge. Other desktop platforms retain the
hidden-window behavior. Interactive second launch, accepted deep link, and
macOS reopen use this authority; explicit background/tray-only launches can
suppress activation. Home/schema preparation refusals before supervisor setup
have a separate Exit-only dialog and start no backend.

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
| Startup-readiness static test passes | Source wiring for native proof and renderer-mount separation | An executed authenticated Tauri IPC exchange, a visible window, or correct pixels |
| Browser hostile-plugin spec passes | Isolated browser-frame containment | Native plugin IPC denial or a release-shell sandbox |
| Sidecar status reaches `failed` after five attempts | Supervisor exhausted automatic sidecar restarts | Cause of the child failure or renderer recovery |
| `STATION_HOME_RESET_REQUIRED` is logged | An incompatible home blocked sidecar startup | Which files may safely be deleted; use backup/reset policy before acting |

Window recreation exists, but this review establishes no automatic
renderer-process-death detection, kill-the-WebView command, or physically
proved bounded renderer-reload loop. There is no packaged startup/retry/Exit
journey receipt here. A missing mount stays
behind the native cover and reaches the existing Retry/Exit surface; it never
authorizes WebsiteData deletion or a CSP bypass.
Do not invent a `tauri-driver` command or claim that the browser test exercises those features.
The historical renderer/stdio work is
[archive#2006](https://github.com/kontourai/station-archive/issues/2006).

Server stdout EPIPE handling does exist. Before runtime initialization,
[`src-server/index.ts`](../../src-server/index.ts) installs the once-only guard
from [`readiness-handshake.ts`](../../src-server/runtime/bootstrap/readiness-handshake.ts),
then routes a broken supervising pipe to graceful shutdown without logging
recursively to that pipe. Synchronous handshake-write refusal and asynchronous
EPIPE have [focused tests](../../src-server/runtime/bootstrap/__tests__/readiness-handshake.test.ts).
They do not prove the packaged Desktop-parent disappearance/closed-stdio
journey. Native HTTP `BrokenPipe` classification is a different boundary.

## Logs and diagnosis boundary

For the Windows permission-helper regression, use an **unelevated** PowerShell
in the repository and a new proof directory:

```powershell
./scripts/verify-windows-path-trust.ps1 -ProofRoot (Join-Path $env:TEMP ('station-acl-proof-' + [guid]::NewGuid()))
```

This executes the native ACL program against current-user-owned directories
and files that initially grant Modify rather than FullControl. Their owner
can harden the DACL without requesting an unnecessary ownership change.
The check also verifies that unrelated access rules are rejected and file
contents are preserved. It refuses elevated execution so administrator
privileges cannot hide the regression. This is helper evidence; native GUI
startup and in-app installation/relaunch remain separate checks.

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
only. The pinned `tauri-plugin-log` 2.9.1 `KeepSome(5)` policy retains up to
five archived logs plus the active `station.log`. The 5 MiB setting is a
rotation threshold, not a hard file-size or 25 MiB total limit: a single
oversized buffered entry can exceed it. Rotation does not make an abrupt
native abort durable.

Use these commands for their separate scopes:

```sh
station doctor
station service status --json
```

Checkout Doctor reports local tool and runtime prerequisites. Packaged Doctor
uses the target command: it reports the selected endpoint, discovery reachability,
saved credential state and configured local service. Neither reports native-window state.
Service status checks a durable installed service, not a Desktop-owned sidecar.
The shell log can show a timeout warning, a secondary-launch request, or an
invalid desktop log level; it cannot prove that a dialog was visible, that a
user chose Retry/Exit, that a window drew, or that a macOS Apple Event callback
did not panic before output flushed.

For the macOS abort class, record separately whether launch used Finder/Dock
or a direct executable: [archive#3496](https://github.com/kontourai/station-archive/issues/3496)
reports the Apple Event path as the observed distinction. There is currently
no established app-owned persisted panic capture or current reproducible trigger,
so preserve the package,
system crash report, timestamp, channel, and launch method rather than claiming
the normal shell log explains it.

## Current development simulator and public fixture receipts

On October 1, 2026, source
`99b6eec01dda1d7149816678f0d8e395725267f3` built, installed and opened as
`io.kontourai.station.dev.instance` on the `dev` channel in an iOS simulator.
The executable SHA-256 was
`c1d16b63032c3e47808191cef5a420462f3391d97d72fa28584dd1b5901cba3d`.
The retained `ios-first-run-build-install-receipt.json` limits its scope to that
simulator build/install. The actual Station manager's **Set up a broker route**
action opened real [relay profiles](../../src-ui/src/views/connections-hub/RelayRouteProfiles.tsx)
through [the Station manager entry](../../src-ui/src/components/OnboardingGate.tsx). That
observed UI entry still performed no fresh enrollment or public application
operation. It is not a physical iPhone, signed Nightly or release receipt.

An October 2, 2026 G8 simulator observation, retained privately outside this
repository, used source revision
`8353059dbd904be879c9cc3369e7f484188a1971`, app identifier
`io.kontourai.station.dev.instance`, iOS 26.5 and executable SHA-256
`62b580335a449b5481673924de1b4180190c8c8ae4174528e9b7e68486030fc3`. The
first bound invitation expired during preview and failed closed without a
cleanup claim. A second invitation showed two saved grants; after explicit
confirmation the host established the older-scope basis for generations 2 and
3, completed local cleanup, and then accepted that same invitation through to
the separate Device-approval step. The later request to access the Device
failed at peer-open with safe code `unknown`, before account sign-in, Device
approval or a Project-member read. This verifies the recovery and routing
handoff only on that exact simulator build. The UI wording has since changed,
so this receipt does not verify the current button copy. Physical iOS, Nightly,
Device peer-open, account continuation and Project access remain **NOT_VERIFIED**.

A later G9 run used published source `05288afd0c21857edf167ecdb318d2bab46de868`
and the installed development app executable SHA-256
`ca4c1156fa6f9ed517c4bb8964396bf0cd8652b3d79d850a6d3734385ac7e4dd`.
After a consumed invitation left two saved grants, a fresh bound invitation
explicitly removed generation 8 through superseded-scope observation and
generation 9 through individual retirement. The same invitation then redeemed;
**Request device access** opened a real peer and showed a public Device
candidate and Station account form. Registration did not create an account:
the five-minute challenge expired during form entry, and the saved expired
attempt could not resume. The G9 Project invitation remained unconsumed.
These are simulator observations, not proof that the newer proactive turnover
or expired-challenge recovery code works in an installed shell. Device approval,
account continuation, Project-member access, signed Nightly and physical iOS
remain **NOT_VERIFIED**.

The separate `public-fixture-registration-renewal-receipt.json` records normal
isolated Station source `d8dd1a41494a9ffbfe42d6f994b3f7f30cc132d4`, public broker
registration at lease revision 1, subsequent renewal at revision 15, and actual
fixed-text shared-work publication. Its cleanup receipt confirms owned process
settlement and native routing-grant cleanup. It records no native client or
application peer. The preserved earlier run expired its initial lease before
registration; a reachable local listener did not qualify that failed public path.

Use the [fresh fixture guide](../../tests/tauri-shell/native-fresh-relay-fixture.md)
and [normal runtime wrapper](../../scripts/native-fresh-relay-fixture.ts) for
artifact-first/provision-last preparation, real operator/provider owners,
private diagnostics and explicit cleanup. The
[default-host WebView harness](../../tests/tauri-shell/native-fresh-relay-acceptance-webview.ts)
is protocol support, not evidence that it ran or that normal user actions passed.
Record main-WebView ceremony, selected relay pair, fresh peer, typed membership,
actual shared document/history, account/Device retirement and physical second
person separately before claiming fresh relay-only acceptance.

## Physical evidence matrix

| Target or behavior | Current runnable evidence | Required physical evidence | Status |
| --- | --- | --- | --- |
| macOS packaged startup, Retry/Exit, Finder/Dock/reopen | Rust/static/UI checks | Installed package, actual native window/dialog, and launch-method record | **NOT_VERIFIED** |
| Windows packaged startup, second launch, tray | Rust/static/UI checks | Installed package, actual shell/tray and service-backend record | **NOT_VERIFIED** |
| Linux packaged startup and indicator behavior | Rust/static/UI checks | Installed package on a supported desktop shell, indicator result recorded | **NOT_VERIFIED** |
| Android/iOS startup recovery | No equivalent desktop readiness harness | Real device and a defined mobile recovery contract | **NOT_VERIFIED** |
| In-shell hostile plugin IPC denial | Separate browser spec and `plugin-host-security` Tauri-WebView lane | Completed exact-binary WebView lane; separate release-platform qualification | **NOT_VERIFIED** in this review (historical archive#2495) |
| Renderer death and bounded reload | Window recreation source; no automatic renderer-death recovery proof established here | Native kill/boot-crash evidence and bounded recovery assertions | **NOT_VERIFIED** (archive#2006) |
| EPIPE/closed stdio | Server stdout guard and synchronous/asynchronous fixture tests | Packaged Desktop-parent disappearance and closed-pipe recovery journey | **NOT_VERIFIED** on native shells (archive#2006) |


## Camera and microphone declarations

The QR scanner and voice input use WebView media capture. Android's post-init
bootstrap restores `CAMERA`, `RECORD_AUDIO`, and `MODIFY_AUDIO_SETTINGS`, with
camera and microphone hardware optional. Check the packaged APK permission
list; the tracked generated-project seed alone is not delivery evidence.

iOS release channels use `src-desktop/Info.ios.plist` for camera, microphone,
and local-network purpose strings; the Dev overlay retains equivalent strings.
macOS channel plists carry the same purpose strings, and `Entitlements.plist`
grants only camera and audio-input access under hardened runtime. The Nightly
installer passes that file to the final signature and verifies both entitlements
from the signed candidate before replacing the installed app.

Declarations enable the OS prompt; they do not grant consent. Physical camera
frames, microphone capture, and persistence still require runtime acceptance.
