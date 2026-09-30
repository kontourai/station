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

Native broker grants now have a host renewal command and a Desktop-only saved-route
supervisor. They maintain already approved, redeemed routing grants while the
renderer is visible; they do not enable native application-route selection or
account/Device enrollment. See the [broker lifecycle contract](../guides/self-hosted-broker.md#native-routing-grant-foundation-v2).

The static `native-platform:ratchet` blocks `@tauri-apps/api` imports and
`__TAURI__`/`__SHARE_TEXT__` globals outside the platform adapter.

### Desktop application signaling commands

The Desktop command table registers three main-window-only signaling commands
in [the native relay owner](../../src-desktop/src/native_relay_redemption.rs):

| Command | Caller input beyond the saved profile name and exact revision | Result |
| --- | --- | --- |
| `station_native_relay_application_binding` | None | Host-derived public profile, scope, native surface and approved Station trust metadata |
| `station_native_relay_application_open` | Nonce and bounded offer SDP | Offer expiry |
| `station_native_relay_application_read` | Existing offer nonce | Optional answer SDP and opaque Station proof, plus expiry |

These are application-named entry points to the same service used by the
diagnostic commands. The host resolves the saved profile, approved Station key
and an existing keyring-held routing grant; it rechecks custody after broker
I/O. Input envelopes reject caller-supplied bearer, private key, broker URL or
Project authority. Requests use fixed broker paths. An uncertain `open` may
already have created an offer: retain its nonce and read that offer within its
window rather than blindly opening it again.

The renderer's [application signaling adapter](../../src-ui/src/platform/native/nativeApplicationSignalingBridge.ts)
wraps these names for one exact saved-profile revision and validates their
results, but no ordinary native application caller composes it. The commands
themselves do not open a DataChannel, verify the returned Station proof,
carry application requests, select a route, sign in or enroll a Device. The
account proof-key vault below remains separate and unwired. Command registration
and source tests are not an executed Tauri IPC, packaged-platform or physical
device receipt; no such execution is claimed by this review.

### Desktop account proof-key foundation

The [account proof-key vault](../../src-desktop/src/native_account_proof_key.rs)
is included only for non-mobile builds. It is Rust-internal: no Tauri command,
capability-report field, renderer adapter or production account-sign-in caller
currently reaches it. It does not change the available connection or recovery
actions.

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

The source includes memory-backend tests and an opt-in macOS Keychain test.
They were not run for this documentation review. IPC, account continuation,
mobile custody and packaged/device behavior require separate integration and
platform evidence.

### Desktop Device proof-key foundation

The [Device proof-key vault](../../src-desktop/src/native_device_proof_key.rs)
is also desktop-only and Rust-internal. Its keyring service and record prefix
are separate from the account and routing vaults. Its exact owner adds a random
Device binding UUID to the app, channel, client instance, Station and Device
IDs. A shared [private custody core](../../src-desktop/src/native_proof_key_core.rs)
preserves the account record format and implements both vaults' storage and
ES256 operations.

The Device vault registers no Tauri command or renderer capability and has no
production signing caller. A key and owner tuple do not establish operator
approval. Bounded signing IPC, runtime Device authorization and a packaged
Project journey remain integration requirements. The software key is decoded
inside Rust for signing; this is not hardware-backed non-exportability.

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

Native distribution, signing, installation, real-device behavior, durable
mobile credentials, inbound native shares, remote-push delivery, and
background mobile agents are
NOT_VERIFIED. #818 adds source-controlled Android/iOS Tauri configuration and
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
