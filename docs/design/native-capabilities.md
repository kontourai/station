# Native platform capabilities

Status: implemented foundation for Station archive#809; native release contract for archive#818 (2026-07-25)

Station is web/PWA-first. The React application talks to exactly one typed
platform boundary at `src-ui/src/platform/native/`; it never imports Tauri
directly or reads Tauri/native globals. The factory is the sole host detector:
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
| Native host-event bridge | unsupported | enabled | The adapter listens for typed `station://share-received` events only. |
| Native share receiver | n/a | disabled | Generic OS share intake remains off; it has a different untrusted-content boundary. |
| Pairing deep link | unsupported | enabled | Only `station://pair?payload=station-pairing:v1:...` is registered. It opens Join for explicit confirmation, never navigates or fetches a supplied URL. |
| Compile-target report | unsupported | enabled | Rust reports target and Station-enabled state. |
| Haptics | unsupported | enabled on mobile compile targets; unsupported on desktop | Official `tauri-plugin-haptics` (archive#1954). Selection/impact/notification kinds only; preference `hapticsEnabled` (default on). |
| Remote push wakeup | unsupported | unsupported | No provisioned FCM/APNs application or server delivery credentials. The capability report names this explicitly; the dormant local poller cannot wake a frozen or closed app (archive#917/#1225). |
| Station service tray | unsupported | report-authoritative | Desktop implementation remains Rust-owned; JavaScript receives no opener permission. |

Desktop startup readiness is also Rust-owned. A sidecar status may carry the
secret-free exact `(generation, instanceId, bootId, apiBase)` observation that
the renderer must match after an authenticated identity read; it is not a
credential and does not authorize arbitrary loopback traffic. The pure epoch
authority has timeout, stale-receipt, loss, retry, activation-deferral, and dev
bypass semantics. OS window reveal/dialog wiring and physical packaged-channel
proof remain **NOT_VERIFIED**; no updater or window-state plugin is introduced.

The current host does not emit inbound share events yet. The event name is a
future-compatible boundary, not a claim that native share-target behavior is
shipped. PWA share URLs keep their existing behavior now. Pairing deep links
are deliberately separate from this generic share boundary.

Both adapters enforce the same 256 KiB text limit before shared content reaches
React state. Rejected native events and host-listener registration failures are
reported through the typed adapter error callback and surfaced to the user.

## Least privilege and threat boundary

`src-desktop/capabilities/default.json` grants JavaScript only
`core:event:allow-listen` and `core:event:allow-unlisten` for the typed host
event bridge. Application commands registered by the Rust host remain outside
the plugin permission surface. The manifest no longer grants `core:default`,
`shell:allow-open`, or `shell:allow-execute`. The desktop tray still opens its
validated local Station URL from Rust through `tauri-plugin-opener`. The
plugin's default JavaScript link interception is disabled, and that Rust-owned
behavior is not a reason to expose generic shell or opener commands to the
webview.

The former external-auth command and research-window command were removed. In
particular, Station no longer combines a user PIN and `AUTH_COMMAND` into a
shell-interpolated command. There is no claimed secure credential backend.

The static `native-platform:ratchet` blocks `@tauri-apps/api` imports and
`__TAURI__`/`__SHARE_TEXT__` globals outside the platform adapter.

### Pairing deep-link threat review (archive#1957)

The `tauri-plugin-deep-link` association is limited to the custom
`station://pair` scheme on Android, iOS, and desktop. The adapter accepts one
`payload` query parameter only: no credentials, URLs to open, arbitrary paths,
fragments, duplicate fields, user info, or ports are accepted. The value must
pass the same `station-pairing:v1:` decoder used by the QR scanner, including
offer expiry, scope, and HTTPS/loopback endpoint validation. The link merely
prefills a Join review screen; the user must explicitly request access before
Station sends any network request. It does not enable generic share intake,
webview navigation, opener permission, or a new credential transport.

## Upstream support versus Station enablement

This matrix is a planning input, not a promise to users. “Upstream” means the
official Tauri v2 support table; “Station” means the code and manifest in this
repository today. A supported upstream plugin is not enabled merely because it
exists.

| Upstream Tauri capability | Official support boundary | Station state |
| --- | --- | --- |
| Deep linking | Partial on Android, iOS, and macOS: schemes must be registered in configuration; runtime registration is not supported. | `tauri-plugin-deep-link` 2.4.9 is enabled only for reviewed `station://pair` links; generic share intake remains disabled. |
| Local notifications | Supported across listed Tauri targets. | enabled, but cannot wake a frozen or closed mobile app. |
| Single instance | Desktop only (Windows mutex, Linux session D-Bus, macOS `/tmp` Unix socket keyed on the app identifier). | `tauri-plugin-single-instance` 2.4.3 with the `deep-link` feature, registered as the first plugin so a second launch exits before any other plugin or setup side effect (one benign pre-builder log-dir write probe still runs) and its argv (a pairing URL on Windows/Linux) is forwarded to the running app; the primary focuses its existing window (archive#2904). Best-effort, not a hard mutex — the home-scoped sidecar claim remains the cross-surface guard. Known limits, accepted: a squatted macOS socket is an availability-only concern — the squatter also sees the launching process's argv/cwd, but no pairing secret transits argv on macOS (Apple Events); once a stable release ships this, a dev build (`tauri dev`, same identifier) will focus the installed app instead of starting. |
| Remote push | Platform support requires FCM on Android and APNs on iOS. | unsupported pending the provider/privacy decision and provisioning tracked by archive#917; archive#1225 remains open. |
| Updater | Desktop only; mobile is unsupported. | disabled; unused updater dependency removed. |
| Dialog | Mobile is partial: no folder picker and path results use URI forms. | disabled. |
| File system | Mobile is partial/sandboxed. | disabled. |
| Opener / shell | Mobile is limited to opening URLs; desktop has broader support. | Rust desktop tray uses `tauri-plugin-opener` 2.5.4 for a validated local HTTP URL only; JavaScript link interception and opener permissions are disabled. |
| Process | Desktop only. | disabled for JavaScript and no process plugin enabled. |
| Credential storage | Platform-native stores are available on mobile. | unsupported for durable mobile pairing. archive#2043 requires host-owned pairing capture and request brokering before any Keystore/Keychain persistence can be enabled. |
| Clipboard | Mobile supports plain text only. | disabled. |
| Autostart | Desktop only. | disabled. |
| Biometric / barcode scanner | Mobile only. | disabled. |

## Plugin selection rule

Do not add a community plugin as an implementation shortcut. Before enabling
any plugin, record a target-specific threat model, maintenance/ownership review,
permissions/capability manifest change, typed adapter operation, and native
device verification. A plugin must be explicitly enabled in Station separately
from its upstream support status. In particular, secure keychain/credential
storage, native inbound share targets, and background agent execution remain
unselected. The narrow pairing association above is not a general inbound-share
capability.

## Version and source record

The JavaScript toolchain ranges are `@tauri-apps/api ^2.11.1` and
`@tauri-apps/cli ^2.11.4`. Rust pins Tauri core to 2.11.5 and `tauri-build` to
2.6.3, and the desktop-only opener plugin to 2.5.4; the checked-in
`src-desktop/Cargo.lock` records the resolved graph.
Sources were reviewed 2026-08-08:

- [Tauri 2 plugin support table](https://v2.tauri.app/plugin/) — platform metadata and plugin support boundaries.
- [Deep Linking](https://v2.tauri.app/plugin/deep-linking/), [Dialog](https://v2.tauri.app/plugin/dialog/), [File System](https://v2.tauri.app/plugin/file-system/), [Opener](https://v2.tauri.app/plugin/opener/), and [Process](https://v2.tauri.app/plugin/process/).
- [Notification](https://v2.tauri.app/plugin/notification/), [Updater](https://v2.tauri.app/plugin/updater/), [Stronghold](https://v2.tauri.app/plugin/stronghold/), [Store](https://v2.tauri.app/plugin/store/), [Clipboard](https://v2.tauri.app/plugin/clipboard/), [Autostart](https://v2.tauri.app/plugin/autostart/), [Biometric](https://v2.tauri.app/plugin/biometric/), and [Barcode Scanner](https://v2.tauri.app/plugin/barcode-scanner/).
- [Tauri crate 2.11.5](https://crates.io/crates/tauri/2.11.5).

## Explicitly unverified

Native distribution, signing, installation, real-device behavior, durable
mobile credentials, inbound native shares, remote-push delivery, and
background mobile agents are
NOT_VERIFIED. archive#818 adds source-controlled Android/iOS Tauri configuration and
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
unit-tested and compiled on macOS; an actual tray click launching the OS browser
remains NOT_VERIFIED on macOS, Linux, and Windows until native shell smoke
coverage exists.

Mobile packages are remote clients. Their Tauri configs inherit only the shared
native-client UI build and cannot bundle the desktop server, Node runtime, seed
data, or server schemas. macOS, Windows, and Linux retain those resources in
platform-specific desktop overrides.
