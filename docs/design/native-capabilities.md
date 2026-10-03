# Native platform capabilities

> **Reading status: native capability architecture with an August support survey.**
> The current [Rust capability report](../../src-desktop/src/lib.rs),
> [JavaScript permissions](../../src-desktop/capabilities/default.json), and
> [dependency manifest](../../src-desktop/Cargo.toml) own build enablement.
> A capability reported enabled means the build can expose it; it is not a
> delivery receipt for a physical device, provider, store, or packaged release.
> The upstream survey below is dated; current native build/release instructions
> live in the [desktop guide](../guides/desktop-build.md) and
> [mobile release guide](../guides/mobile-release.md).

Status: implemented foundation for Station #809; native release contract for #818 (2026-07-25)

Station is web/PWA-first. The React application talks to exactly one typed
platform boundary at `src-ui/src/platform/native/`; it never imports Tauri
directly or reads Tauri/native globals. The platform factory selects the adapter:
it checks Tauri's official `window.__TAURI_INTERNALS__` runtime marker,
asynchronously loads the Tauri-only adapter and SDK when present, and otherwise
selects the deterministic web adapter. The marker selects an adapter; it is not
an authorization boundary. User-agent inference is prohibited.

## Current Station surface

The boundary reports `enabled`, `disabled`, `unsupported`, or
`permission-required`, and command calls return a typed success, unsupported,
or error result. Tauri's `native_capability_report` command reports its actual
compile target and Station-enabled states. Before that report is read,
desktop-tray remains `disabled` rather than being guessed from the JavaScript
host.

| Capability | Web/PWA | Current Tauri host | Notes |
| --- | --- | --- | --- |
| PWA share URL intake | enabled | n/a | Preserves `share`, `text`, `url`, and `title` query parameters and removes them after delivery. |
| Native host-event bridge | unsupported | enabled | Share intake uses `station://share-received`; separate typed subscriptions handle tray navigation, bundled-server status and startup-readiness retry. |
| Native share receiver | n/a | disabled | Generic OS share intake remains off; it has a different untrusted-content boundary. |
| Pairing deep link | unsupported | enabled | Release schemes are `station-stable`, `station-beta`, and `station-nightly`; isolated development configuration uses a generated `station-dev-<suffix>` scheme. The pairing route accepts only `pair?linkVersion=1&clientChannel=<channel>&payload=station-pairing:v1:...`, opens Join for explicit confirmation, and never navigates or fetches a supplied URL. |
| Native relay link delivery | unsupported | iOS source path; other targets unsupported | Separate `station-relay-<channel>` associations deliver public routing metadata and an opaque pending handle. Build enablement and compilation do not qualify installed cold/warm delivery. |
| Compile-target report | unsupported | enabled | Rust reports target and Station-enabled state. |
| Haptics | unsupported | enabled on mobile compile targets; unsupported on desktop | Official `tauri-plugin-haptics` (station#1954). Selection/impact/notification kinds only; preference `hapticsEnabled` (default on). |
| Remote push wakeup | unsupported | build-dependent | Enabled for Android builds carrying all four Firebase values or iOS builds carrying the Live Activity plugin. iOS also checks push signing before offering registration. User opt-in, server registration and provider delivery remain separate. |
| Station service tray | unsupported | report-authoritative | Desktop implementation remains Rust-owned. The renderer may request native menu reveal through one typed command but receives no opener permission, URL, port, or menu mutation authority. |

Desktop startup readiness is also Rust-owned. A sidecar status may carry the
secret-free exact `(generation, instanceId, bootId, apiBase)` observation that
the renderer must match after an authenticated identity read; it is not a
credential and does not authorize arbitrary loopback traffic. The pure epoch
authority has timeout, stale-receipt, loss, retry, activation-deferral, and dev
bypass semantics. OS window reveal/dialog wiring and physical packaged-channel
proof remain **NOT_VERIFIED**. Readiness does not depend on a window-state
plugin; conditional desktop updater registration is a separate owner below.

The current host does not emit inbound share events yet. The event name is a
future-compatible boundary, not a claim that native share-target behavior is
shipped. PWA share URLs keep their existing behavior now. Pairing deep links
are deliberately separate from this generic share boundary.

Both adapters enforce the same 256 KiB text limit before shared content reaches
React state. Rejected native events and host-listener registration failures are
reported through the typed adapter error callback and surfaced to the user.

### iOS relay URL intake

The [native intake owner](../../src-desktop/src/native_relay_link_intake.rs)
admits only the closed `station-native-relay-link/v1` envelope in
`station-relay-<channel>://relay#relay-link=<base64url JSON>`. Decoded JSON is
bounded to 16 KiB. Production origins must be canonical HTTPS; an actual
debug/development receiver also admits exact numeric loopback HTTP. The link
either carries public route intent or wraps the existing installation-bound
native v2 invitation. Application origin remains an untrusted routing hint.
Opening a link does not save or select a route, approve a surface or Station
key, authenticate a person, approve a Device, or grant Project/compute access.

The [iOS public delegate owner](../../src-desktop/src/native_relay_ios_launch.rs)
captures cold launch options and consumes relay URLs before Tao's warm parser.
It forwards pairing and unrelated URLs to their original callbacks. The generic
deep-link runtime plugin is not initialized on iOS; its build-time generator
still owns pairing configuration. [The app build owner](../../src-desktop/build.rs)
adds the separate relay association only to iOS. Android retains pairing and
does not register a relay-secret association.

These commands are registered in both host dispatch tables, with main-app
origin checks on operations. Registration does not enable link intake on other
platforms:

| Command | Input | Public result |
| --- | --- | --- |
| `station_native_link_delivery_mode` | None | `station-owned` on iOS; `plugin` elsewhere |
| `station_native_pairing_link_take` | None | Pending pairing URLs for the separate pairing parser |
| `station_native_relay_link_take` | None | Public delivery or rejection metadata; no invitation secret |
| `station_native_relay_link_cancel` | Pending handle | Clears pending custody and fences continuation |
| `station_native_relay_link_begin` | Pending handle, saved profile name and exact update timestamp | Existing independently unapproved Station-key candidate |
| `station_native_relay_link_redeem` | Pending handle, saved profile name, exact profile revision and update timestamp | Existing structured routing-grant result |

`station://native-relay-link` carries the same secret-free delivery DTO. A
subscriber registers before draining launch delivery; `take` can recover public
metadata for the same still-pending handle after an interrupted consumer.
Cancellation and expiry remove that handle. Expiry clears host custody; it does
not emit a separate expiry event. Consumers use the published deadline and host
currentness checks rather than treating stale displayed metadata as admission.

The host keeps invitation bytes in bounded zeroizing memory until explicit
redemption, cancellation, supersession or expiry. New link mutation arguments
carry only opaque handles. The secret is not placed in renderer events, saved
profiles or notifications; this does not promise erasure of OS-owned transient
URL objects. A bound invite still needs the existing public-proof/operator
surface approval and independent full Station key/code comparison. Cancellation
before trust precommit prevents a new trust write; cancelling routing does not
revoke a Station key already explicitly committed by the user. Late routing
grant results retain the existing exact-grant retirement/quarantine path.
Compilation and focused host tests do not establish installed iOS delivery,
mobile storage behavior or a completed collaborator journey.

## Least privilege and threat boundary

`src-desktop/capabilities/default.json` grants the typed event bridge plus the
listed app-name, window-drag/maximize, notification, haptics, and deep-link
operations. It is the exact JavaScript permission inventory; event listening
is not its only permission. Application commands registered by the Rust host remain outside
the plugin permission surface. The manifest no longer grants `core:default`,
`shell:allow-open`, or `shell:allow-execute`. The desktop tray opens its validated local Station UI or fixed `/ui` API-docs
URL from Rust. A separate `open_external_link` command admits user-clicked HTTPS
URLs without embedded credentials through the OS opener. The renderer's menu-reveal request carries no URL. The
plugin's default JavaScript link interception is disabled, and that Rust-owned
behavior is not a reason to expose generic shell or opener commands to the
webview.

The former external-auth command and research-window command were removed. In
particular, Station no longer combines a user PIN and `AUTH_COMMAND` into a
shell-interpolated command. The native host now owns a credential broker: platform keyrings retain Station
bearers and Rust performs bounded authenticated requests without returning
bearer values to the WebView. That source boundary is not physical-device
qualification of every platform store.

Native broker grants have a host renewal command and a saved-route supervisor
composed by [ApiBaseProvider](../../src-ui/src/contexts/ApiBaseContext.tsx) on
desktop and mobile. They maintain already approved, redeemed routing grants
while the renderer is visible; renewal grants no application, Device, account
or Project authority. The separate [selected-route owner](../../src-ui/src/platform/native/nativeRelayConnectionOwner.ts)
and [fresh enrollment ceremony](native-relay-enrollment.md) supply those distinct
source paths. See the [broker lifecycle contract](../guides/self-hosted-broker.md#native-routing-grant-foundation-v2).

The static `native-platform:ratchet` blocks `@tauri-apps/api` imports and
`__TAURI__`/`__SHARE_TEXT__` globals outside the platform adapter.

<a id="desktop-application-signaling-commands"></a>

### Native application signaling commands

Desktop and mobile hosts register main-window-only commands for public binding metadata and
the separate host-owned native application peer. The existing
`station_native_relay_application_binding` command remains the source of the
saved profile's public scope, client surface and approved Station trust view.
The peer commands in the [native peer owner](../../src-desktop/src/native_application_peer.rs)
are:

| Command | Caller input | Result |
| --- | --- | --- |
| `station_native_application_peer_prepare` | Saved profile name and exact profile revision | Versioned opaque peer handle, host nonce, client connection ID and expiry |
| `station_native_application_peer_open` | Peer handle and bounded offer SDP | Peer expiry |
| `station_native_application_peer_read` | Peer handle | Versioned answer, Station proof and expiry after host transcript verification |
| `station_native_application_peer_sign` | Peer handle and exact method, path and bounded body bytes | Versioned native Device request proof |
| `station_native_application_peer_close` | Peer handle | No result |

The host derives authority from the selected profile, approved Station trust,
current Device receipt and existing routing custody. The renderer supplies no
broker URL, bearer, key, nonce, Project authority, proof claims or audience.
Uncertain `open` results are recovered by reading the same handle; the client
does not open a second peer. The adapter is separate from diagnostic signaling.
Connect verifies the Station proof before applying the answer, then uses the
host signer for bounded per-request Device proof. Station composes this in its
[application runtime](../../src-ui/src/platform/native/nativeRelayApplicationRuntime.ts)
for an explicitly selected native saved route. Its read surface is limited to
Station health, authority and member Project/shared-work reads; fixed account
challenge/exchange/revoke and invitation acceptance are separate control leaves.
Account continuation and Project membership remain independent. A mounted
consumer is not proof of a completed fresh native or physical Project journey.

Rust verifies the exact Station-signed nonce, connection identity, offer/answer
digests and both DTLS fingerprints. It owns transcript state and one proof per
handle, not browser RTC connectivity. The handle/nonce exist before network open;
owner/epoch changes, replay and expiry refuse. Read deadlines can shorten but
cannot extend prior polling deadlines, and the adapter retires expired handles.

The source adapter and focused tests do not establish executed Tauri IPC,
packaged-platform behavior, physical-device qualification or a completed
authenticated Project journey. The account proof-key vault below also remains
separate from account sign-in and enrollment.

<a id="desktop-account-proof-key-foundation"></a>

### Native account proof-key foundation

The [account proof-key vault](../../src-desktop/src/native_account_proof_key.rs)
is included in desktop and mobile builds. The vault remains Rust-internal; the
[account operation owner](../../src-desktop/src/native_account_operations.rs)
reaches it through five main-window commands, with no raw signing IPC. The
[production account bridge](../../src-ui/src/platform/native/nativeAccountSessionBridge.ts)
composes those commands with the selected encrypted native application owner;
the [account panel](../../src-ui/src/views/connections-hub/RelayRouteProfiles.tsx)
is its ordinary UI caller. This source composition does not qualify fresh
onboarding or a physical device.

The vault uses a separate OS-keyring service and account namespace from the
broker routing proof key. Its owner binds the app identifier, channel, client
instance, Station and approved Device IDs. Restore and signing require an exact
owner match and rederive the public JWK and thumbprint from the stored private
key. Missing, corrupt or unavailable keys refuse those operations; there is no
plaintext fallback.
Create, restore, replace, revoke and ES256 signing remain explicit Rust methods.
This is software-key custody: Rust holds decoded private bytes while signing.
Owner construction validates identifiers; it does not establish Device approval
or account authority, and the signer itself does not validate a request protocol.

`station_native_account_challenge_prepare` restores or creates the independent
account key for the reconciled host Device owner and returns its public key,
fixed challenge body and opaque handle. `station_native_account_exchange_prepare`
accepts closed opaque challenge data and local username/password credentials;
Rust derives identity, hashes, JTI and time and returns the complete exchange
body and matching proof header. `station_native_account_request_headers` accepts
opaque native continuation data and only the canonical GET/HEAD health and
member-read inventory. `station_native_account_accept_invitation_prepare`
accepts one canonical invitation token for its fixed POST leaf;
`station_native_account_revoke_prepare` prepares only the empty-body native
revoke leaf. No caller-supplied audience, Device, surface, hash or signing bytes
reach these operations.

Sixteen process-local contexts are bounded to fifteen minutes and the current
grant lifetime. Preparation exposes its actual `contextExpiresAtMs`; the SDK
captures it once and clamps the continuation/public scope to the earlier
host/server expiry. A delayed sign-in cannot extend that host context. One exchange consumes a context before signing; challenge IDs
remain consumed for the full host challenge window independently of shorter
untrusted expiry hints. Current profile, Device/epoch, trust, grant and binding
are checked through the shared live-owner callback. Effective challenge or
continuation expiry and the actual account key are checked again after key/sign
waits before a result returns. Refusal preserves the key. An existing account-bound
paired Device and approved native Device binding are server prerequisites;
that Device can come from existing pairing or the separately acknowledged
[native enrollment ceremony](native-relay-enrollment.md). The account operation
does not itself bootstrap a Device or an unsupported provider.

The source includes memory-backend tests and an opt-in macOS Keychain test.
Unit checks do not establish IPC, account continuation, mobile custody or
packaged/device behavior; those require separate integration and platform evidence.

<a id="desktop-device-proof-key-foundation"></a>

### Native Device proof-key foundation

The [Device proof-key vault](../../src-desktop/src/native_device_proof_key.rs)
is also shared across native targets and remains Rust-internal. Its keyring service and record prefix
are separate from the account and routing vaults. Its exact owner adds a random
Device binding UUID to the app, channel, client instance, Station and Device
IDs. A shared [private custody core](../../src-desktop/src/native_proof_key_core.rs)
preserves the account record format and implements both vaults' storage and
ES256 operations.

The vault remains Rust-internal. A main-window-guarded
`station_native_device_binding_candidate` command in the
[native relay owner](../../src-desktop/src/native_relay_redemption.rs) returns
only the public candidate descriptor. Under one locked profile-store snapshot,
the selected relay-route profile supplies Station, trust, grant and surface;
the separately host-authorized profile supplies the active paired Device. They
must share the same store revision, client instance and exact Station origin.
The [candidate manager](../../src-desktop/src/native_device_binding_candidate.rs)
persists that owner snapshot and a provisional binding ID in a private
Keychain namespace before creating the Device proof key, then returns only the
public JWK and thumbprint. It retains the initial Device-authorization epoch
for provenance and resumes the same key after reauthorization, while keeping
the profile revision, Station, Device, trust, route and surface exact. No
renderer caller currently uses this command. It does not submit operator
approval, reconcile a server receipt, bind a peer session or sign a request. A
key and owner tuple do not establish operator approval. Server-side Device
authorization exists in the opt-in pilot; the separate native peer owner now
supplies fixed request-signing IPC for a reconciled approved Device. A fresh
packaged or physical Project journey remains a qualification requirement. The software key is decoded
inside Rust for signing; this is not hardware-backed non-exportability.

The separate main-window command `station_native_device_binding_self_receipt`
loads an existing candidate and reads its fixed Station receipt URL through the
native HTTP owner. It accepts only the saved profile and expected revision;
the bearer stays in Rust. One process-wide nonblocking guard prevents overlapping
reads from overwriting newer observations. The HTTP exchange has a 45-second
deadline, including capacity wait, and a 4 KiB response limit. Receipt-only
global and body budgets leave ordinary HTTP and open-ended SSE behavior unchanged.

After HTTP, profile and authority locks cover owner revalidation, receipt
validation, the Keychain observation write and result construction. The current
host authorization epoch is separate from the Device proof binding UUID. A
matching receipt reports `current` or `not-current`; only the closed versioned
404 response records `not-found`. Transport failure or the versioned unavailable
response may return a prior observation with `source: cached-observation` and
its original timestamp. A prior positive observation is labeled
`previously-confirmed-current`, never fresh `current`. Missing, malformed,
mismatched or unavailable readback preserves the candidate and key. The peer and
account operation owners require a positive observation bound to the current
owner/epoch; ordinary route-selection UI does not automatically invoke this command.
Source and Rust/HTTP fixtures do not establish an executed native IPC or packaged journey.

<a id="desktop-paired-device-identity-custody"></a>

### Native paired-Device identity custody

The [Device custody owner](../../src-desktop/src/native_device_custody.rs) keeps
a versioned companion beside the existing bearer in a separate OS-keyring
namespace. The authenticated pairing exchange captures the Device ID and kind
in host-held pending state. The companion binds the native app and channel,
credential reference, bearer digest, exact origin, Station and client instance.
Neither the bearer nor its digest is returned to the renderer.

The Rust-internal resolver holds the profile-file lock and checks the current
authorized profile, revision and epoch against the bearer and companion.
Missing, malformed or mismatched metadata refuses Device identity resolution;
ordinary legacy HTTP credential use remains independent. This establishes no
Device-key approval, account or Project authority and exposes no signing IPC.

Credential retirement records durable, profile-scoped intent before a profile
removal or replacement. Public and cold-start retries permit cleanup only,
check the original credential digest and refuse an intervening replacement or
reauthorization. An unreadable legacy entry without a trustworthy digest stays
quarantined for manual removal. Its journal entry can be released only after
both owned keyring entries are confirmed absent, without attempting deletion.

Pending pairing handles remain process-memory state; they do not survive a
crash. Cold observation of a completed profile and retirement recovery are
separate from unfinished pairing recovery. Mobile pairing commit, selection,
deletion, profile removal and cold cleanup use the same custody and retirement
owners as desktop. Mobile metadata stays in the application's private config
directory and retains its existing mobile lock protocol; desktop process-birth
ownership is not substituted. A compound Device capture receives the already
locked profile path, so it does not retake mobile's genesis lock.

The shared [secret entry](../../src-desktop/src/native_secure_entry.rs) selects
the OS-backed mobile store separately for each namespace. iOS writes use
`AfterFirstUnlockThisDeviceOnly`. Foreground reads distinguish a missing item
from locked or unavailable storage; a background convenience read cannot turn
those failures into absence. These settings and software-key custody do not
establish hardware non-exportability or physical background/lock behavior.

On September 30, 2026, source
`c8f4f46d043674770b67cf26f41f541433a74de9` compiled, packaged, installed and ran
as the isolated `io.kontourai.station.dev.instance` application on an iOS 26.5
simulator. Its executable SHA-256 was
`e74a0cd8f345c51b80e7fd2f47646b56e5194e6e393c1b6671bf109dcd38bdbe`.
Actual main-WebView IPC observed `tauri://localhost`, iOS and the development
channel. It completed independently compared Station-key approval, host-held
routing-grant redemption, a real account-bound Device pairing exchange, the
requires-auth → bearer-and-companion → configured transaction, and host active
selection. Device candidate capture matched the pairing Device and completed in
414 milliseconds; exact operator approval and the authenticated Station
self-receipt returned `current`. No bearer was returned to the renderer.
The stale profile revision refused, and local credential deletion completed.

The first receipt qualifies paired bootstrap and custody using a synthetic local
account and the real source runtime. A later revocation attempt reached an
expired five-minute fixture process, and the prepared full Project run then
failed its startup prerequisite under host resource exhaustion. Neither failure
is counted as a passed application scenario.

A separately recorded full run reused that same installed iOS simulator
executable and the existing native account/RTC acceptance helper. Its isolated
Linux Station/Pion/TURN runtime used clean source
`f5eda517106a4547d1934e841f0fca25e4785655`; explicit SSH TCP forwards exposed
only fixture-owned loopback endpoints to the simulator. Real Keychain/IPC and
the account provider completed protected Project read (200), fresh-peer
reconnect (200), account revocation (401), reauthentication (200) and Device
revocation (403). Every read recorded a fresh host peer, a selected relay pair,
relay candidates in the offer and zero direct Project HTTP attempts. Successful
reads contained the expected Project; revoked reads contained no Project payload.
Both account challenge/exchange pairs returned 200 and passed their closed
version, target, Device and surface checks. Owned profile/grant cleanup returned
an empty profile store; the runtime stopped, its TURN container disappeared,
and the three owned SSH forwarders closed.

This qualifies the development iOS simulator and that SSH fixture topology.
It does not qualify ordinary native onboarding, fresh relay-only enrollment,
signed or physical iOS Nightly, public TLS/TURN/NAT reachability, a hosted service,
or physical two-human use. No timeout increase or CSP relaxation was used.

A newer development iOS simulator build/install receipt names source
`99b6eec01dda1d7149816678f0d8e395725267f3`, application
`io.kontourai.station.dev.instance` on the `dev` channel, and executable SHA-256
`c1d16b63032c3e47808191cef5a420462f3391d97d72fa28584dd1b5901cba3d`.
It built, installed and opened on October 1, 2026. The actual Station manager
now renders **Set up a broker route**, whose click opens the real
[relay profiles](../../src-ui/src/views/connections-hub/RelayRouteProfiles.tsx)
through [the Station manager entry](../../src-ui/src/components/OnboardingGate.tsx). This
proves that entry was reachable on the exercised simulator build; it proves no
fresh enrollment, public application traffic or physical Nightly operation.
See the [shell verification evidence](../guides/native-shell-verification.md).

Source tests and the macOS Keychain roundtrip do not establish
physical-device Project access.

### Pairing deep-link threat review (station#1957)

The `tauri-plugin-deep-link` association uses the custom channel-specific scheme
configured for a native build. On its `pair` route, the adapter accepts exactly
one each of `linkVersion`, `clientChannel`, and `payload`: no credentials, URLs to open, arbitrary paths,
fragments, duplicate fields, user info, or ports are accepted. The value must
pass the same `station-pairing:v1:` decoder used by the QR scanner, including
offer expiry, scope, and HTTPS/loopback endpoint validation. The link merely
prefills a Join review screen; the user must explicitly request access before
Station sends any network request. It does not enable generic share intake,
webview navigation, opener permission, or a new credential transport.

The same scheme also has a separate Rust-owned `open-browser` route. Its
optional `origin` must be a credential-free
HTTP loopback origin at the owned UI port, without a path beyond `/`, query or
fragment. The check admits the listed loopback aliases at that port; it does
not require the original hostname spelling. The host obtains the
launcher bootstrap through its local consent boundary; this route is not a
pairing payload and the pairing adapter excludes it.

## Upstream support versus Station enablement

This matrix is a planning input, not a promise to users. “Upstream” means the
official Tauri v2 support table; “Station” means the code and manifest in this
repository today. A supported upstream plugin is not enabled merely because it
exists.

| Upstream Tauri capability | Official support boundary | Station state |
| --- | --- | --- |
| Deep linking | Schemes are build-time configuration, not runtime registration. | The pinned `tauri-plugin-deep-link` admits the reviewed pairing and owned-local-browser routes above; generic share intake remains disabled. |
| Local notifications | Supported across listed Tauri targets. | enabled, but cannot wake a frozen or closed mobile app. |
| Single instance | Desktop only (Windows mutex, Linux session D-Bus, macOS `/tmp` Unix socket keyed on the app identifier). | the pinned `tauri-plugin-single-instance` with the `deep-link` feature, registered as the first plugin so a second launch exits before any other plugin or setup side effect (one benign pre-builder log-dir write probe still runs) and its argv (a pairing URL on Windows/Linux) is forwarded to the running app; a foreground second launch requests activation of its existing window, while a background launch does not (station#2904). Best-effort, not a hard mutex — the home-scoped sidecar claim remains the cross-surface guard. Known limits, accepted: a squatted macOS socket is an availability-only concern — the squatter also sees the launching process's argv/cwd, but no pairing secret transits argv on macOS (Apple Events); an unisolated `tauri dev` using the installed app’s identifier can activate that app instead of starting a separate one; isolated development configuration uses its own identifier. |
| Remote push | Platform support requires FCM on Android and APNs on iOS. | Build-dependent enablement as above. See [notification delivery](notification-delivery.md) for payload, opt-in and recorded qualification scope. |
| Updater | Desktop only; mobile is unsupported. | Rust registers it only when the desktop build has usable updater configuration. This is not proof an update feed or signed release is available. |
| Dialog | The original survey recorded partial mobile support. | Enabled for Rust-owned consent dialogs; this does not expose a generic JavaScript file picker. |
| File system | Mobile is partial/sandboxed. | disabled. |
| Opener / shell | Platform behavior remains target-specific. | Rust-owned tray and reviewed external-link commands use the opener on desktop/mobile; JavaScript link interception and generic opener permissions remain disabled. |
| Process | Desktop only. | Registered by the desktop host; JavaScript authority still depends on the applicable capability manifest. |
| Credential storage | Platform-specific OS stores. | Host-owned pairing capture, credential persistence and request brokering are implemented. No fallback to a plaintext store is implied; runtime/device qualification remains separate. |
| Clipboard | Mobile supports plain text only. | disabled. |
| Autostart | Desktop only. | disabled. |
| Biometric / barcode scanner | Mobile only. | disabled. |

## Plugin selection rule

Do not add a community plugin as an implementation shortcut. Before enabling
any plugin, record a target-specific threat model, maintenance/ownership review,
permissions/capability manifest change, typed adapter operation, and native
device verification. A plugin must be explicitly enabled in Station separately
from its upstream support status. In particular, native inbound share targets and background agent execution remain
unselected; the implemented credential broker has its own authority boundary. The narrow pairing association above is not a general inbound-share
capability.

## Version and source record

Use the [JavaScript manifest](../../package.json), [Rust manifest](../../src-desktop/Cargo.toml),
and lockfiles for exact installed versions. The following external-source survey
was reviewed on 2026-08-08; it is not a current dependency inventory:

- [Tauri 2 plugin support table](https://v2.tauri.app/plugin/) — platform metadata and plugin support boundaries.
- [Deep Linking](https://v2.tauri.app/plugin/deep-linking/), [Dialog](https://v2.tauri.app/plugin/dialog/), [File System](https://v2.tauri.app/plugin/file-system/), [Opener](https://v2.tauri.app/plugin/opener/), and [Process](https://v2.tauri.app/plugin/process/).
- [Notification](https://v2.tauri.app/plugin/notification/), [Updater](https://v2.tauri.app/plugin/updater/), [Stronghold](https://v2.tauri.app/plugin/stronghold/), [Store](https://v2.tauri.app/plugin/store/), [Clipboard](https://v2.tauri.app/plugin/clipboard/), [Autostart](https://v2.tauri.app/plugin/autostart/), [Biometric](https://v2.tauri.app/plugin/biometric/), and [Barcode Scanner](https://v2.tauri.app/plugin/barcode-scanner/).
- [Tauri crate 2.11.5](https://crates.io/crates/tauri/2.11.5).

## Explicitly unverified

Physical release distribution, signing/store delivery, real-device credential
lifecycle, inbound native shares, remote-push delivery and background mobile
agents remain **NOT_VERIFIED** by the receipts on this page. Development
simulator build/install and the older paired simulator IPC journey are narrower
observed results, not physical Nightly acceptance. #818 adds source-controlled Android/iOS Tauri configuration and
a fail-closed GitHub workflow contract, not credential-backed distribution
proof. The only secretless mobile output is an unsigned iOS simulator archive
marked verification-only; it is never a distributable asset. The 2026-07-25
arm64 simulator probe compiled, packaged, installed, launched, and visibly
rendered Station's branded connection UI. Its fresh-client “Can't reach server”
state is expected without a configured Station server, so simulator operational
smoke is **PASS**; it remains neither a signed distribution nor a device/store
readiness claim. A device IPA,
signed Android APK/AAB, signed desktop packages, notarization, Windows trust,
Play upload, and App Store upload require protected-environment credentials and
provider receipts before they can be claimed. The validated opener boundary is
unit-tested and compiled on macOS; actual tray endpoint clicks and renderer-led
menu reveal remain NOT_VERIFIED on macOS, Linux, and Windows until native shell
smoke coverage exists.

Mobile packages are remote clients. Their Tauri configs inherit only the shared
native-client UI build and cannot bundle the desktop server, Node runtime, seed
data, or server schemas. macOS, Windows, and Linux retain those resources in
platform-specific desktop overrides.
