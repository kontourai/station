# Native relay enrollment

This page records the additive backend foundation for fresh native enrollment.
The ordinary client flow and fresh enrollment routes remain unmounted. The
existing native Device-proof pilot still requires an already paired Device.

The [native contract](../../packages/contracts/src/native-relay-enrollment.ts)
separates Station trust, routing scope, native installation surface, fresh
account verification, operator Device approval and activation. Expiries use
integer milliseconds. A native surface has a host-derived app identifier,
channel, client instance and routing-key thumbprint; it has no browser Origin.

The [surface registry](../../src-server/services/connections/native-surface-registry.ts)
stores explicit operator approvals in private SQLite state. Its
[operator routes](../../src-server/routes/system/native-relay-surface-routes.ts)
require a current real operator credential before and after bounded body reads.
The route capability is exactly GET/POST
`/api/pairing/native-relay-surfaces`, at `access:manage`. Approval permits
transport admission, never Device, account or Project access. The registry
retains revoked tuples and limits its complete history to 16 records; capacity
exhaustion fails closed rather than evicting revocation evidence.

The [connector](../../src-server/services/connections/self-hosted-broker-connector.ts)
can resolve approved surfaces while preserving its existing fixed-surface
adapter. It polls the broker for each exact approved surface in the current
Station/enrollment/routing generation. The
[native Pion adapter](../../src-server/services/connections/native-v2-pion-application-adapter.ts)
captures one immutable approval per peer and rechecks it through Station proof
issuance, request admission and response delivery. Revocation fences that
peer's private provenance. These adapters are not mounted by this foundation.

## Credential delivery

The [Station sealer](../../src-server/services/identity/native-relay-envelope.ts)
and [native recipient owner](../../src-desktop/src/native_enrollment.rs) use
[RFC 9180 HPKE](https://www.rfc-editor.org/rfc/rfc9180.html), base mode, with one
fixed suite: DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and AES-128-GCM
(`0x0010/0x0001/0x0001`). Recipient keys are distinct from Device, account and
routing proof keys. SEC1 public points and standard HPKE encapsulations use
canonical base64url encoding. Every delivery creates a fresh single-shot
encryption context.

An ES256 compact JWS under the independently approved Station signing key
authenticates the complete delivery metadata and the plaintext bundle's SHA-256.
The exact signed payload bytes become HPKE additional authenticated data;
the fixed native enrollment version is the HPKE `info`. The host verifies the
signature and its retained expected tuple before decryption, then verifies the
signed plaintext digest before permitting custody. Encrypting a replacement
bearer under the publicly known recipient key cannot replace that digest.
The WebView receives ciphertext and public metadata, never the Device bearer
or recipient private scalar.

The Rust recipient owner binds private OS storage to app/channel, saved profile
revision, Station audience, routing generation, grant digest and peer nonce.
It uses `NativeSecureEntry`; on iOS that adapter selects
`AfterFirstUnlockThisDeviceOnly`. This module registers no renderer IPC.
Its caller must retain the authoritative attempt, challenge and candidate,
recheck current owners around awaits, and own durable cleanup/reconciliation
before it publishes a profile or activation receipt. Those lifecycle and
mounted application seams remain unfinished.

The pinned libraries are `@hpke/core@1.9.0` and Rust `hpke@0.13.0` with default
features disabled and only `alloc,p256`. Registry publication metadata was
checked against the repository's 24-hour release-age policy. The TypeScript
release follows the fix for
[GHSA-73g8-5h73-26h4](https://github.com/dajiaji/hpke-js/security/advisories/GHSA-73g8-5h73-26h4).
The [Rust maintainer](https://github.com/rozbb/rust-hpke/blob/v0.13.0/README.md)
states that the crate has not been formally audited; the cited Cloudflare review
covered version 0.8. Interoperability checks do not replace an audit.

## Evidence and remaining integration

The retained
[P-256 vector](../../src-desktop/src/fixtures/native-enrollment-hpke-p256-base.json)
comes from the finalized HPKE reference vectors distributed with the pinned
Rust crate. TypeScript and Rust tests independently open it. An explicitly
invoked Rust interoperability test opens a freshly generated TypeScript
Station-signed envelope and refuses wrong-owner, expiry, tampering,
post-cancellation and validly encrypted replacement-bearer cases. Missing
interoperability fixture input fails the test.

These checks establish cryptographic assembly and source-level authority
fences. They do not establish a Tauri IPC journey, Keychain prompts, mobile
backgrounding or physical iOS operation. The remaining integration must add
the fresh enrollment-only peer, durable attempt journal, supported provider
verification, exact operator candidate approval, Device/binding activation,
Keychain staging/ACK recovery and account continuation. It must qualify the
ordinary native UI over a public relay with a physical second person before
claiming the full [relay acceptance](connection-broker.md).
