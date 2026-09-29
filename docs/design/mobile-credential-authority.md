# Mobile credential authority boundary

> **Status: historical blocker record, superseded at source level;
> current-owner check 2026-09-26.** The
> [native host](../../src-desktop/src/lib.rs) now registers the credential broker
> for mobile targets, selects mobile OS keyring storage and iOS
> `AfterFirstUnlockThisDeviceOnly`, and uses the
> [Android system resolver](../../src-desktop/src/android_dns.rs) for native HTTP.
> [Android generation](../../scripts/apply-android-native-bootstrap.mjs) owns
> backup exclusions; the [native profile adapter](../../src-ui/src/platform/native/stationProfileStorage.ts)
> consumes the host-owned path. The prior DNS observation, blocked status and
> session-only fallback below describe the earlier implementation. This source
> check does not prove physical secure-storage, networking, restart or backup
> behavior; follow [Native shell verification](../guides/native-shell-verification.md)
> for platform evidence requirements.

## Retained blocker record

Status: blocked on Station #2043; #898 remains open.

Station must not persist a renderer-owned bearer map in Android Keystore or
iOS Keychain and then hydrate that map into the WebView. Secure-at-rest storage
does not make a secret safe after it crosses IPC into renderer memory.

The accepted boundary is the existing desktop shape: the native host captures
the pairing response, commits the bearer only after an awaited/versioned
transaction, returns secret-free profile readiness, and injects authentication
inside a narrow request broker. Mobile cannot reuse that implementation as-is:
the current broker uses Rust `ureq`, while physical Android verification
recorded in `notification-delivery.md` shows native Rust DNS resolution fails
even when the WebView can reach the same HTTPS host. Enabling the command on a
mobile cfg would therefore ship a broker that cannot reach normal Station
hosts.

Until a supported Android/iOS host networking implementation is selected and
device-verified, mobile keeps its existing session-scoped web credential path;
it does not claim restart persistence. The rejected renderer-hydrated vault was
removed. #2043 must also land explicit Android backup/data-extraction exclusion
and iOS ThisDeviceOnly accessibility ratchets with the host vault, so a restored
application backup cannot clone a paired-device bearer.
