# Native relay enrollment

This page records the native enrollment ceremony and its evidence boundaries.
Server routes are composed only with `STATION_NATIVE_ENROLLMENT_PILOT=1`, the
existing native Device-proof pilot, a configured relay and a supported pending
account provider. Ordinary solo operation does not construct this service.
The host commands are registered on desktop and mobile. The combined Rust
source compiles and its library tests pass; physical iOS lifecycle and the
complete ordinary UI journey still require qualification.

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

The separate [relay-management routes](../../src-server/routes/system/relay-management-routes.ts)
serve the desktop/native invitation panel through the runtime-owned connector
issuer. A current operator or explicitly promoted `relay:manage` Device can
approve/revoke an exact surface, issue one-use invitations and approve/deny a
pending Device. The captured decision retains the actual human actor and
rechecks Device/account/provider currentness and the target after awaits.
This does not change the original operator-only pairing routes, enroll an
account, or grant Project membership. Native Project administration additionally
requires Project IAM. The account-bound gate now admits only exact native relay
leaves with current Device/account proof and separate `relay:manage`; ordinary
credential-only account-bound Devices remain gated. Capabilities grant nothing;
this source addition is not released Nightly, physical-device or two-human proof.

The [connector](../../src-server/services/connections/self-hosted-broker-connector.ts)
can resolve approved surfaces while preserving its existing fixed-surface
adapter. It polls the broker for each exact approved surface in the current
Station/enrollment/routing generation. The
[native Pion adapter](../../src-server/services/connections/native-v2-pion-application-adapter.ts)
captures one immutable approval per peer and rechecks it through Station proof
issuance, request admission and response delivery. Revocation fences that
peer's private provenance. Connector configuration accepts either the existing
fixed native surface or `nativeClient: { kind: 'station-native-registry' }`; the
registry mode polls only exact operator-approved surfaces.

## Native link intake

The [link contract](../../packages/contracts/src/native-relay-link.ts) has two
forms. Public route intent carries the Station application address, broker
address and Station/enrollment identifiers. The receiver reviews that
untrusted metadata before saving a route and preparing its public installation
proof. A bound invitation adds the unchanged native v2 invitation for that
exact installation. The operator's surface approval and independent Station
key comparison remain mandatory. Neither form grants account, Device, Project
or compute authority merely by being opened.

The [sender codec](../../packages/shared/src/native-relay-link.ts) encodes
the envelope in a fragment under a distinct `station-relay-*` scheme. Production
links require canonical HTTPS origins. Only development links allow exact
numeric loopback HTTP origins. The host checks its installed channel and
development scheme, closed envelope, size, expiry and surface. The browser's
same-origin v1 invitation parser is a different contract.

The [iOS delivery owner](../../src-desktop/src/native_relay_ios_launch.rs)
captures application launch options and public scene/application URL callbacks.
It verifies the pinned app-owned delegate boundary and forwards unrelated
delivery to its original owner. Relay URLs are consumed before the upstream
warm parser; the generic deep-link runtime is not initialized on iOS. That
plugin retains its raw last URL, so a React-state clear alone would not satisfy
this custody contract. Android relay associations remain unregistered until
its native Intent boundary is qualified.

The [intake state](../../src-desktop/src/native_relay_link_intake.rs) retains
the bound secret in bounded native memory and emits only public metadata and
an opaque pending handle. Discovery and explicit redemption consume that
handle, not invitation JSON in renderer mutation variables. Cancellation and
supersession fence in-flight work; an issued late grant is retired by exact
identity or retained in durable cleanup. Independently approved Station trust
is not revoked by cancelling routing intake. Cancellation before its trust
write must prevent the write. No claim is made that OS-owned or every transient
URL-parser allocation is erased.

The existing [secure-entry adapter](../../src-desktop/src/native_secure_entry.rs)
is also the mobile grant backend: it preserves absence versus locked-store
errors and iOS device-only access. A desktop-only default keyring entry cannot
substitute for the maintained mobile store.

Source-level intake, cancellation, exact-grant compensation and codec checks
are separate from installed-client evidence. An installed development iOS
simulator build at `d956082d3` opened a non-secret public setup link while the
app was stopped and while it was running. Closing either review preserved the
saved profile bytes and existing Station confirmation. The ordinary saved
Station screen also displayed the empty routing-grant state without a storage
error. The earlier `4cf503807` build rejected this delivery; the corrected
owned-delegate guard is included in the successful build.

These observations do not qualify bound-secret delivery, successful pairing,
mobile grant writes/readback/deletion, protected application traffic, signed
Nightly distribution or the physical two-person journey. Those remain
**NOT_VERIFIED** until their own receipts exist.

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
`AfterFirstUnlockThisDeviceOnly`. The
[host coordinator](../../src-desktop/src/native_enrollment_host.rs) retains the
attempt, Station challenge, exact Device candidate and private bundle in OS
storage. It writes an allocation index and owner intent before recipient key
creation, and clips Station's signed enrollment deadline to the host recipient
deadline. Request bodies and proof digests use [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785.html).

Each ceremony operation uses a fresh
[verified enrollment peer](../../src-desktop/src/native_enrollment_peer.rs). The
application channel carries one request. A bounded host request handle retains
its verified tuple after network cleanup, so accepting a signed response does
not require a still-open RTC connection. Status/recovery signs a new current
peer nonce while preserving the original owner, recipient and candidate.
Network cleanup is distinct from explicit user cancellation.
Once delivery is staged, renderer disposal or signal cleanup preserves the
owned attempt for status reconciliation, including after a successful server
activation response that native acceptance could not confirm. Explicit user
cancellation still requests retirement of that exact attempt.

Device setup has a five-minute deadline, clipped to the routing grant and
recipient deadline. The accepted host challenge exposes only that public expiry
alongside its candidate. The account form closes when the deadline passes and
clears entered credentials. Expired login/registration cannot create an account,
consume its person invitation or authorize a Device.

An expired saved candidate remains in native custody until Station confirms a
terminal state. Recovery permits only status or cancellation; it never retries
account submission. Status/cancel may carry the retained public candidate when
registration never reached the server. Station checks the reserved Device,
installation surface, distinct proof key and purpose-bound signature before
signing a terminal response. Native custody is cleaned only after accepting
that response. Then the user can request a fresh challenge with the existing
routing grant and enter account details again. A lost activation result still
requires a status check before cancellation or a new setup. After an uncertain
activation result, the UI offers **Check Device status** instead of another
activation or cancellation. A signed pending response keeps this check available;
only verified active or terminal status resolves the attempt. Troubleshooting
shows the fixed failure stage, allowlisted code and HTTP status, never a raw
server error or credential. An expired saved delivery also checks status first;
its local deadline does not establish whether Station already committed it.

A newer routing generation can carry terminal status or cancellation of an
expired saved candidate when the broker, Station application address, Station
and enrollment IDs, approved installation surface and Station trust are
unchanged. The [native host](../../src-desktop/src/native_enrollment_host.rs)
keeps the original challenge, recipient and proof-key owner. Only the transport
and response peer nonce are fresh. The saved profile must have no Device
credential, and the attempt must have no staged delivery or possible activation.
Only a signed terminal response can release its custody; this path never returns
pending or active authority, retries credentials, or renews the old ceremony.

New journal rows retain their broker origin. Older rows can recover only when
[Station trust custody](../../src-desktop/src/native_station_key_custody.rs)
proves the original trust revision still has exactly one approved binding for
that profile, installation, Station and enrollment. Ambiguous or changed
approvals fail closed. Login, registration, finalization and activation retain
their exact-generation checks. A committed Device whose activation result was
lost needs the separate activation-publication recovery path, not this expired
candidate cleanup.

The [service](../../src-server/services/identity/native-relay-enrollment-service.ts)
uses the supported provider's private pending session owner. The local username
provider adds invitation-gated registration using its maintained signup and
sign-in APIs. Pending provider sessions remain outside ordinary account
authority until ACK promotion. An authenticated operator approves the actual
issuer/subject and exact candidate through GET
`/api/pairing/native-relay-enrollments` and POST
`/api/pairing/native-relay-enrollments/:enrollmentId/approve`. The legacy browser
Pairing confirm route does not approve this native candidate.

The [private SQLite journal](../../src-server/services/relay/native-relay-enrollment-journal.ts)
persists lifecycle, provider references and proof replay state; it contains no
Device bearer. After a signed activation receipt, the host reuses the existing
pending-pairing transaction to write bearer and Device companion, publish the
configured profile and adopt the preapproved Device key/binding without minting
a replacement candidate. Publication returns an owned transition and new profile
revision; its fixed currentness lookup checks the actual local profile, grant,
trust and Device candidate independently of RTC. Partial writes retain their
exact credential reference for reconciliation. Explicit cancellation invalidates
in-flight captures and retires only that owned reference.
The publication handoff rechecks the same routing grant after the profile gains
its Device credential. This path accepts only the enrollment's exact credential
reference and matching Station identity in the published profile. Ordinary
invitation redemption still requires an unconfigured profile. Paired application
operations separately verify the active native Device identity and current signed
Device receipt before using that route.
Existing-grant status, renewal, signaling and ICE configuration use the same
host-owned routing custody after publication. They accept the saved credential
reference only with the matching published Station identity; that metadata adds
no account, Project or Device authority. Redemption keeps its fresh-profile path.
Saved enrollment recovery resolves its own credential reference from the journal
and refuses ambiguous references before checking the current route.
Station-key status and explicit revocation also remain available after publication,
with the exact profile, application, installation, broker, Station and enrollment
binding. Credential-bearing profiles must name that same Station. Preparing or
approving fresh key enrollment still requires an unconfigured manual profile.
Active receipt deadline validation permits at most five seconds of positive
clock skew beyond Station's 30-second receipt window, matching the existing
status timestamp allowance. Already expired receipts and deadlines beyond that
bounded window remain refused; signature, tuple and host currentness checks
still apply.

The sealed bundle contains the Device bearer only. Activation does not create an
account continuation or Project membership. The native account challenge/exchange
uses a separate account key and login; accepting a Project invitation remains
an independent account/self-service operation.

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
backgrounding or physical iOS operation. Focused server integration exercises actual Project invitation eligibility, the
maintained local provider, real operator credentials, private Pion adapter facts,
Device/binding owners, sealed delivery, ACK, new-peer status and cancellation.
An await barrier around actual Station receipt crypto verifies that concurrent
Device revocation cannot return a stale signed ACTIVE receipt. The enrollment test replaces the Pion process with typed in-memory channels.
A separate mounted runtime test now drives the actual native account challenge,
exchange, invitation acceptance and protected Project HTTP consumer using
private adapter provenance. It refuses direct HTTP imitation, conflicting
Origin/cookies, replayed proofs, changed bodies and revoked account sessions;
account revocation preserves the independently approved Device.

The [default native client](../../src-ui/src/platform/native/nativeRelayEnrollmentClient.ts)
and [wizard](../../src-ui/src/views/connections-hub/NativeRelayEnrollmentWizard.tsx)
mount the host-owned Device enrollment ceremony,
including explicit operator approval, activation and recovery from the host
journal. Ordinary route selection composes fresh ICE, verified Station proof,
Device signing and a separate account continuation for a bounded read surface.
These are executed frontend and server composition checks with mocked native
IPC/peer boundaries, not a packaged-client result. Recovery hints do not grant
account or Project authority; an unknown activation publication is rechecked
against the host before its configured revision is accepted.

The [selected connection owner](../../src-ui/src/platform/native/nativeRelayConnectionOwner.ts)
composes a separate [account bridge](../../src-ui/src/platform/native/nativeAccountSessionBridge.ts),
including actual native revocation and host-deadline-clamped public scope. The
[entry boundary](../../src-ui/src/platform/native/NativeRelayEntryBoundary.tsx)
loads an [ephemeral member shell](../../src-ui/src/views/native-relay/NativeRelayMemberShell.tsx)
for the selected native route, independently of operator Workspace providers.
Membership reads require the current account, Device and Project authority;
contribution writes remain outside the fixed read-only enrollment grant.
The simulator Station manager broker action now reaches the real relay-profile
UI; that observed entry does not establish the ceremony.

The October 1 public fixture separately observed actual connector registration
(lease revision 1), subsequent renewal (revision 15), fixed human shared-work
publication and confirmed owned cleanup. The preserved early-init run instead
expired before first registration. These are real server/operational receipts,
not a native client or application-peer result. The
[fixture guide](../../tests/tauri-shell/native-fresh-relay-fixture.md) and
[operator guide](../guides/self-hosted-broker.md) retain their ordering and limits.

Actual Keychain/process-relaunch lifecycle, the newly composed Tauri IPC journey,
public TURN application traffic and physical iOS operation remain
**NOT_VERIFIED** for this slice. The ordinary native UI must qualify those
seams with a physical second person before claiming full
[relay acceptance](connection-broker.md).
