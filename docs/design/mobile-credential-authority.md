# Mobile credential authority boundary

Status: blocked on Station archive#2043; archive#898 remains open.

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
removed. archive#2043 must also land explicit Android backup/data-extraction exclusion
and iOS ThisDeviceOnly accessibility ratchets with the host vault, so a restored
application backup cannot clone a paired-device bearer.
