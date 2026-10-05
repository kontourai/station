# Optional Station connection broker

> **Reading status: broker requirements with local implementation milestones.**
> [Broker service](../../src-server/services/connections/self-hosted-broker-service.ts),
> [connector](../../src-server/services/connections/self-hosted-broker-connector.ts),
> [protected application dispatcher](../../src-server/services/connections/virtual-application.ts),
> and [Device enrollment](../../packages/connect/src/core/brokerRouteEnrollment.ts)
> own separate parts of the path. The local lab and recorded transport results
> do not establish production enablement, native activation, or actual remote
> delivery. Dated target sections preserve their original scope.

> Status: architecture record for [#45](https://github.com/kontourai/station/issues/45).
> The owner accepted delegated security judgment and required a free local test
> path on September 12, 2026. Intermediary confidentiality and local testability
> are requirements. The September 20 implementation target below selects the
> self-operated WebRTC/Pion/TURN path. The local browser UI milestone merged in
> [#2451](https://github.com/kontourai/station/pull/2451); native client delivery,
> remote/physical proof and production enablement remain separate.
> [#1963](https://github.com/kontourai/station/issues/1963) owns the full
> implementation. This decision did not itself deliver an internet-facing deployment.
> The later operator-approved test deployment is recorded separately below.

## Implementation target — September 20, 2026

Proceed with a self-operated broker and connector using the existing signed
WebRTC handshake, the browser's DataChannel implementation, a maintained Pion
Station peer, and a configurable TURN service. The local profile uses the
existing pinned coturn fixture. This is an implementation target, not production
approval for a particular binary, hosted provider, deployment or network.
Production TURN/TLS, supported native runtimes and actual remote delivery must
qualify independently. The Node UDP backend remains useful diagnostic evidence;
it does not acquire TURN/TCP support from Pion's results.

Native desktop has a separate [OS-keyring routing-grant vault](../../src-desktop/src/relay_grant_vault.rs),
and a host-owned Device enrollment ceremony. The ordinary saved-route owner
now composes `/native-application`, fresh ICE, Device proof and a separate
account continuation for bounded health and member Project reads. Operator
Workspace features, contribution writes and physical iOS qualification remain
separate. See [native enrollment](native-relay-enrollment.md). The browser protocol binds
`browserOrigin` to a canonical HTTP(S) page Origin and the broker checks that
same Origin on signaling. Packaged Tauri WebViews use different platform
schemes, so a saved native grant cannot be activated by pretending its WebView
has an HTTPS browser Origin or by returning the grant secret to renderer JS.
[#2485](https://github.com/kontourai/station/issues/2485) owns the versioned
native client identity and host-owned signaling contract required before native
route activation. The dated paired macOS debug and development iOS simulator
receipts below observed their actual WebView/native surfaces; fresh physical
Nightly behavior remains unverified.

The broker is a separate process and state owner. It carries bounded enrollment,
reachability and signaling metadata, never decrypted application requests or
Station/plugin execution. The Station connector dials outbound. Its application
channel enters the protected Station runtime through the existing virtual
application seam, with no synthesized socket/loopback identity. HTTP proxying
through a local privileged connection is not an implementation shortcut.

The first usable self-operated path must include these integrated behaviors:

1. An operator explicitly links one Station to one broker and independently
   approves its signing key on the Device. The broker's routing credential and
   the Station's approved Device/account credentials have separate custody and
   revocation. Neither broker provisioning nor a signaling message can enroll
   a decrypting endpoint or grant Project membership.
2. Connector registration and every connection attempt name the exact Station,
   enrollment and generation. Generation-conditional renewal, withdrawal and
   cleanup cannot mutate a replacement allocation. Challenges expire and are
   consumed once; a new connection needs fresh proof after failed setup.
3. The broker forwards only a closed, size-bounded signaling vocabulary. The
   Device verifies the independently admitted Station key and signed exact
   offer/answer before accepting the peer. The Station admits the requesting
   Device through its existing authority. The broker cannot supply a new trusted
   signing key, arbitrary dial target, plugin or application credential.
4. Browser application requests use the existing credential resolver, account
   continuation signer and bounded channel adapter. Per-call credentials that
   bypass the configured transport must not turn direct HTTP success into relay
   evidence. Private Project denial, role changes and account/Device/membership
   revocation are required on the same real encrypted path.
5. The connector owns transport startup, cancellation, expiry and teardown;
   reconnect creates a new connection and never replays an uncertain mutation.
   The Device reports reachability and authorization separately. A separately
   configured direct route must work when the broker is stopped.

Deliver a documented local start/check/stop composition without cloud accounts,
paid identity, billable models or user-wide trust changes. Use current account
and Project contracts rather than inventing a broker identity product. Later
hosted account discovery may compose the approved provider contract, but is not
required to run this self-operated path. A local static credential or synthetic
account fixture must never be described as production account authentication.

**Enablement gates.** [#2030](https://github.com/kontourai/station/issues/2030)
owns the reproduced unshared-Project read through an approved read-only Device;
[#488](https://github.com/kontourai/station/issues/488) owns complete member
resource authority. A transport-only pass cannot enable shared access while
those boundaries fail. [#1985](https://github.com/kontourai/station/issues/1985)
retains integrated lab acceptance, and [#497](https://github.com/kontourai/station/issues/497)
retains the real two-person/device journey. Separate code, local-runtime,
remote/native and hostile-tenant isolation receipts throughout delivery.

## Public test deployment — October 1, 2026

The operator-approved test broker runs as a separate loopback-bound process on
the operator's Linux host, reached through the named Cloudflare Tunnel at
`https://relay-test.kontourai.com`. The tunnel exposes broker signaling only;
Station application HTTP is not published through it. Cloudflare TURN supplies
short-lived ICE credentials. Application traffic remains encrypted to the
independently approved Station peer.

Executed setup checks establish public TLS, authenticated scoped ICE issuance,
credential reuse and rejection of unauthenticated/foreign Station requests,
a TURN allocation, and broker service restart/SQLite backup restoration. These
checks do not establish native application traffic or Zach's physical iPhone
journey. The approved $0 subscription includes metered overage and has no hard
spending cap; this is a limited monitored test, not unlimited free hosting.
The [operator guide](../guides/self-hosted-broker.md) owns issuer configuration,
rate limits and the distinction between issuance limits and byte/spending caps.

A later isolated normal Station run at source
`d8dd1a41494a9ffbfe42d6f994b3f7f30cc132d4` observed public connector registration
at lease revision 1 and renewal at revision 15. Its real local operator
published fixed human TaskRoom message/document text, and the owned process
group/native routing-grant cleanup completed. The earlier failed scope remains
preserved: provisioning before artifact preparation let the initial 60-second
lease expire before registration. See the
[fixture diagnosis](../../tests/tauri-shell/native-fresh-relay-fixture.md#executed-startup-failure-provisioned-too-early).
Neither run exercised a fresh native client or public encrypted application peer.

Development simulator source `99b6eec01dda1d7149816678f0d8e395725267f3` built,
installed and opened; its Station manager broker action reaches the real route
UI. That is a separate UI-entry result, not fresh enrollment, application
traffic, physical iOS Nightly or release promotion.

## Purpose and boundaries

The broker helps a device find and reach an enrolled Station. The Station
retains application sessions, Project membership and execution admission.
Ordinary application forwarding by one Station to a peer remains a different
operation: it interprets work and the receiver owns execution. Inference-only
sharing also remains distinct. See [peer pairing](station-peer-pairing.md),
[inference fleet](inference-fleet.md), and
[Project membership](project-membership.md).

The proposed components are:

| Component | Location and state |
| --- | --- |
| Device connection layer | Device-local profiles, credential custody and retry policy |
| Broker | Account/Station links, endpoint allocation generations, revocation and bounded discovery metadata |
| Tunnel provider | Encrypted traffic transport; no application plaintext or endpoint private keys |
| Station connector | Outbound tunnel lifecycle on the enrolled computer |
| Station core | Application authority, Project state and authorized work |

The broker runs no tenant plugins, tools or agents and holds no Station
operator or provider credential. Account login is not Project membership.
Optional notifications have a separate payload policy and delivery grant.

## Reuse and reference comparison

Station already has [environment identity and proof](../../src-server/services/ssh/environment-security-service.ts),
[endpoint selection](../../packages/connect/src/core/environmentProfiles.ts),
a transport-neutral [ConnectionSupervisor](../../packages/connect/src/core/ConnectionSupervisor.ts),
[pairing](../../src-server/services/ssh/device-pairing-service.ts), and
[outbound peer credentials](../../src-server/services/peers/peer-credential-store.ts).
Reuse those owners; keep discovery metadata separate from secret custody and
inbound grants separate from outbound grants. A device's successful connection
does not prove the server can reach the same endpoint.

Prior art: an existing self-hosted product separates its hosted broker from
normal traffic. Its environment supervises cloudflared; the client uses the
tunnel endpoint after bootstrap. Credential renewal may need the broker again.
Its relay implementation depends on its own contracts, client runtime and
hosted identity and tunnel provisioning. Reuse mechanisms and failure cases
from it rather than importing that application wholesale.

Station's current public proof uses a credential-derived HMAC. A broker must
not gain verification by receiving that operator credential. Add a separately
scoped asymmetric enrollment key through a versioned contract, with public-key
pinning, rotation and explicit old-key retirement. This is new protocol work;
it is not already supplied by the current HMAC proof.

## Enrollment and connection protocol

1. An authorized operator enables exposure for one exact Station, account and
   broker issuer. The Station proves its enrollment key and confirms the
   operator-approved link. Challenge audience, nonce, scope and expiry are
   checked by both parties; discovery cannot self-enroll a machine.
2. The broker allocates a stable endpoint using a generation-owned operation.
   Record partial external resources before proceeding. The local connector
   accepts only the intended loopback service, not an arbitrary caller URL.
3. A signed-in device requests a connection to an active link. The broker asks
   that Station to mint a short-lived, one-time bootstrap bound to the exact
   Station, client proof key, audience, principal-binding request and operation.
4. The device exchanges bootstrap directly with the Station for a device/session
   grant. Existing membership and scope policy decides usable authority. A
   broker token is never an application token. Broker requests cannot select
   arbitrary Project, operator, terminal or execution privileges.
5. The device uses the selected endpoint for normal application traffic.
   Renewal repeats the required authorization checks. The broker does not
   receive the resulting application credential.

Keep account-to-Station enrollment, person-to-device binding and Project
invitation as separate records with separate revocation. The approved
[#1513](https://github.com/kontourai/station/issues/1513) identity contract
must be supplied; do not substitute a provider login for a member record.

## Optional access and failure behavior

| Situation | Required outcome |
| --- | --- |
| No broker configured | Local/direct/LAN/tailnet/SSH access retains its own authentication path |
| Broker unavailable | Existing valid grants may work over a surviving tunnel; new bootstrap/renewal reports unavailable |
| Tunnel unavailable | Managed traffic fails visibly; broker availability does not imply a usable Station |
| Another route exists | Use only a separately reachable, identity-verified, authorized endpoint; no automatic trust widening |
| Account changes | Remove that account's managed registrations/credentials without deleting independent direct profiles |
| Link revoked | Refuse new bootstrap and apply the declared session-revocation policy at the Station |
| Connector exits | Report offline separately from unlinked; retain enrollment intent |
| Old cleanup arrives late | Its generation cannot delete a replacement tunnel or authorization |
| Remote mutation response is lost | Preserve possible execution; transport reconnect cannot replay it automatically |

Revocation must specify how long an unreachable Station may accept an existing
grant. An online-only revocation promise is not enforceable during a partition.
Bounded credential lifetimes and refresh policy make this tradeoff explicit;
local independent access remains a separate authority.

## Accepted confidentiality requirement

The owner delegated this decision after requesting the stronger long-term
design: application content must remain encrypted through broker and tunnel
intermediaries. This resolves the transport-confidentiality choice in #45/#46;
it does not decide whether a trusted Station's stored content is unreadable to
that Station's operator. The latter remains a separate storage-policy decision.
The plaintext endpoints are the authorized Device and selected Station; this
is not a claim that a managed Station operator, authorized runner or chosen
model provider cannot see the content it must process.

Encryption alone is insufficient. The broker must not silently replace the
Station key or authorize its own client key. Bind endpoint keys through an
operator-approved enrollment or a separately delegated, authenticated admission
policy. A connection ticket is not permission to add a decryption endpoint.
New-device admission, key rotation/recovery and membership revocation require
explicit failure and compromise cases. Never accept a new trusted key merely
because the same broker that routes traffic supplied it.

Reuse a maintained authenticated transport implementation, with protocol review
and test vectors; do not design bespoke encryption. The initial pilot can keep
using [Tailscale's encrypted device transport](https://tailscale.com/security),
including encrypted DERP forwarding. Its
[Tailnet Lock design](https://tailscale.com/docs/features/tailnet-lock) illustrates
why key admission is separate from data encryption; this recommendation does
not configure or change a user's tailnet. The
[Noise framework](https://noiseprotocol.org/noise.html) likewise leaves key
acceptance to the application, so choosing a library alone is not the protocol.

Treat browser/app distribution and plugin code as endpoint trust. An
intermediary that can replace the client code or an unrestricted plugin at the
endpoint can defeat a content-confidentiality claim without breaking the
cipher. State what code/signing origins are trusted, preserve isolated plugin
boundaries, and test the actual browser/native delivery shape.

Broker logs and push notifications omit transcripts, code and tool output.
Operational metadata such as timing, traffic size and necessary endpoint/account
relationships remains disclosed. Storage encryption and recovery under #46 are
separate from this transport guarantee. A provider-terminated HTTPS connection
alone does not satisfy the requirement; an approved transport must preserve
end-to-end content protection through that provider.

TLS can meet this boundary when it terminates at the selected trusted Station
and the intermediary forwards encrypted bytes. If a provider terminates the
outer TLS connection, a separately authenticated inner encrypted channel must
preserve that same boundary. The requirement does not mandate a new application
cipher or per-Project content-key system. The selected browser/native transport
must support endpoint authentication without disabling certificate checks.

## Confidentiality and deployment alternatives

A managed HTTPS tunnel can simplify reachability, but its TLS termination and
operator visibility differ from application-level end-to-end encryption. Do not
claim the relay cannot read transcripts merely because the broker Worker is
not carrying them. [#46](https://github.com/kontourai/station/issues/46) owns
the associated content/storage policy decision.

| Alternative | Benefit | Cost or limitation |
| --- | --- | --- |
| Keep direct/tailnet/SSH only | Existing trust and operational footprint | No universal sign-in-and-connect convenience |
| Provider-backed managed tunnel | Reuses mature transport and outbound connectors | Provider dependency and explicit traffic confidentiality policy |
| Self-hosted traffic relay | Operator controls deployment and routing | Station team owns transport capacity, abuse controls and recovery |
| Application-encrypted transport | Can reduce intermediaries' content access | Key distribution, recovery and multi-member sharing become protocol requirements |

Recommended sequence: define the provider-neutral broker contract and isolated
integration fixture first; choose one managed transport implementation only
after it meets the accepted confidentiality requirement and its signing trust
and operating ownership are approved. Do not invent
an encryption scheme or a second identity product. The self-operated two-person
Project pilot proceeds over existing access paths independently.

## Required free local test path

[#1985](https://github.com/kontourai/station/issues/1985) owns a local lab that
remains usable without cloud accounts, paid identity or tunnel services,
billable model calls, or Tailscale sign-in. Paid or hosted adapters may add
convenience; they must not become prerequisites for developing or testing the
core protocol. The [local lab guide](../guides/local-collaboration-lab.md)
provides the first transport/enrollment fixture command. Full Station UI,
membership, compute and plugin integration remains a delivery requirement.

The intended local topology is:

```text
Device profile A or B -- authenticated encrypted connection --> selected Station
                                through a local blind relay
```

Run two disposable Station homes and separate Device profiles with distinct
credentials. Use loopback ports allocated by the lab, deterministic fixture
providers and disposable keys. Leave existing Station homes and user services
alone. The relay receives neither endpoint private keys nor application
credentials. Test direct access separately with the relay stopped; this proves
that relay use is optional without promising automatic failover.

The first bounded transport fixture may use maintained TLS implementations
and ephemeral, explicitly pinned local certificate trust. Certificate and
hostname verification remain enabled; no global trust-store change or broad
browser certificate-ignore flag is permitted. Fixture certificates establish
the test's intended endpoint, not the production enrollment or browser
distribution story. Those paths require their own integration evidence.

| Stage | Required evidence |
| --- | --- |
| Transport and enrollment | Real authenticated encryption through a blind relay, explicit person/device approval, independent credentials, wrong-Station refusal and device revocation |
| Project collaboration | Two distinct people join with current Project permissions; denied resources remain denied; authorized independent work uses only offered compute and permitted plugins |
| Failure and compromise | Wrong certificate/key, endpoint substitution, tampering, stale or replayed bootstrap, reconnect, rotation and revocation cannot widen authority or silently repeat work |

Keep synthetic identity creation inside the owned fixture composition, never a
remotely selectable production trust header. Integrate the real Station-local
account adapter from [#1981](https://github.com/kontourai/station/issues/1981)
when available; until then, label actors as synthetic. A fixture does not
verify the production Tailscale identity adapter. Pairing a device also does
not grant Project membership or justify an operator credential in a guest UI.

Tests must use actual owning authorization paths as each capability lands.
Missing Project, compute or plugin behavior is reported as incomplete, never a
successful skipped scenario. Transport verification includes both successful
peer authentication and refusal of an untrusted endpoint before application
data is sent; absence of a plaintext marker in captured bytes is insufficient
on its own. Bound process lifetimes and clean up only lab-owned resources.

Local fixtures do not prove separate-human/device acceptance under
[#497](https://github.com/kontourai/station/issues/497), real internet/NAT
reachability, or hostile-process isolation under
[#487](https://github.com/kontourai/station/issues/487). Report those receipts
separately. In particular, two homes running as the same OS user are not a
tenant security boundary.

## Acceptance and decisions

### Connection proof contract

[#2000](https://github.com/kontourai/station/issues/2000) owns the independently
admitted signing key and connection-proof lifecycle. The initial
[contract](../../packages/contracts/src/connection-proof.ts),
[shared JOSE verifier](../../packages/shared/src/connection-proof.ts) and
[Station issuer](../../src-server/services/ssh/connection-proof-issuer.ts)
are exercised by the browser transport fixture. Production key enrollment,
Device approval/recovery and bootstrap issuance are not enabled by this slice.

The [Station signing-key store](../../src-server/services/ssh/connection-signing-key-store.ts)
owns private local custody in `security/connection-signing-key.json`. It reuses
the existing environment identity and guarded JSON mutation/publication owner.
The private PKCS8 key never appears in its public descriptor; the public key is
derived through Node's crypto implementation. Existing keys survive reopening
and concurrent initialization converges on one identity. A local rotation must
match the observed Station, enrollment, generation and public key under the
mutation lock; exactly one competing rotation can advance it.
The issuer reloads current custody and refuses to sign with a retired generation.

This is a local storage primitive, not an enrollment or administration API.
Private-home access is required, and public descriptor export does not approve
the key at a Device. Corrupt, oversized, linked, unsupported or wrong-Station
records fail instead of being silently regenerated. A reset environment cannot
adopt the old signing record. POSIX private file/directory permissions are
checked; this does not claim Windows ACL or hostile-same-user isolation.

Rotation changes the signing identity and requires the Device trust owner to
admit the new generation through its approved path. It does not silently replace
client trust, recall plaintext, terminate existing application work or rotate
independent direct-access credentials. Key loss/backup restoration and active
home fencing retain explicit recovery work. The shared publisher's rename is
the visible commit point; directory-fsync limitations do not justify claiming
perfect crash durability or automatically retrying an uncertain rotation.

The [Device trust store](../../packages/connect/src/core/connectionTrust.ts)
retains independently approved public keys and revoked generations in the
browser's IndexedDB partition. It serializes revision comparisons across tabs
and the browser rechecks this state and proof expiry before accepting a peer
description. The [local lab guide](../guides/local-collaboration-lab.md#device-side-signing-trust)
describes its operator-approval precondition, storage failures and recovery limits.
This is a connection-layer component; it does not supply the production approval
UI, recover a changed enrollment, or grant account/Project access.

Use a separately admitted P-256 signing key with compact JWS/JWT `ES256` from
the maintained `jose` implementation. Do not negotiate an algorithm from broker
input or fetch signing keys from token headers. The protected header contains
only `alg`, `typ` (`station-connection-proof+jwt`) and `kid` (the approved public
JWK's SHA-256 thumbprint). The exact audience is
`urn:station:connection-proof:v1`; the issuer is `urn:station:<stationId>`.
This is transport proof, not a general login token.

The closed version-1 binding names the Station, enrollment, positive generation,
connection ID, client nonce, client and Station certificate fingerprints, and
SHA-256 digests of the exact offer and answer bytes. The nonce and connection
ID originate in the Device. Binding expectations and signing-key trust come
from their local owners, never from decoded broker claims. Browser gathering
precedes signing. The native client also permits a bounded relay-only local
offer snapshot when gathering stalls after valid UDP relay candidates arrive;
the exact snapshot remains bound to signaling and proof digests. See the
[native transport contract](../reference/connect.md#optional-native-application-transport).
Extra unsigned candidate updates are refused. A future
trickle-ICE protocol needs its own authenticated update contract.

Proofs use integer-second `iat`, `nbf` and `exp`, with `nbf = iat` and an exact
30-second lifetime. Clock tolerance is zero in this initial contract. Expired,
future-dated, wider-lifetime, wrong-audience, cross-Station, stale-generation,
wrong-client, changed-SDP and changed-key proofs fail. Clock skew is an explicit
connection refusal, not permission to extend a grant. The Station's trusted
admission callback must permit issuance both before and after asynchronous
signing. The verifier rechecks current local trust and expiry after asynchronous
verification, then permits exactly one successful consumption per handshake;
concurrent verification cannot consume the same handshake twice.

An invalid attempt does not consume the challenge. After successful proof
consumption, failed connection setup requires a fresh challenge/connection;
reloading must not restore an already-consumed handshake. This in-memory
verifier is not a durable Station bootstrap replay ledger. Production issuance
and exchange still require the owning authorization transaction and replay
record, separate from this cryptographic proof.

The browser fixture supplies signing-key trust through its private controller
to model independent admission. It checks the proof in real browser WebCrypto
before accepting the SDP, refuses an altered proof and replay, and still
requires actual DTLS certificate verification. It retains its explicit
certificate pin as an additional test boundary; the fixture does not implement
production signing-key or certificate rotation. Its Station admission callback
is test-owned and does not verify an external account. No remotely selectable
trust header, Project membership or operator credential is introduced.

### Protected application dispatch

`StationRuntimeOptions.virtualApplication` is an opt-in, trusted process
composition seam for a connector. It supplies the canonical Station origin and
a `ready` callback receiving `fetch(Request)` and a retirement `AbortSignal`.
No listener, broker account or remote enablement is created by this option.
The callback runs only after full runtime initialization and route coverage
validation. A replacement initialization retires the previous dispatcher;
shutdown prevents late publication and stops pending response delivery.

The owner in `src-server/services/connections/virtual-application.ts` dispatches
fresh Requests into the same protected Hono application without Node socket or
proxy metadata. Station-owned account descriptor/session reads and invitation
acceptance reach their ordinary authorization owner; provider cookie operations
remain excluded, and relay login uses the continuation provider flow. It rejects foreign targets, cookie operations, cookie headers,
trusted ingress/proxy headers and HTTP hop headers. Cookies remain an HTTPS
mechanism; the connector transports the SDK's opaque account continuation and
proof with its independently approved Device credential and actual client
Origin. Account, Device, Project and execution checks remain in their existing
owners. Responses that set cookies are refused, and redirects are returned
without following them. These refusals do not roll back an application action
that has already executed, so the connector must not retry mutations silently.

The ingress bounds simultaneous requests, counting open response bodies, to 32.
Body consumption supplies backpressure. Client cancellation releases response
custody, while retirement rejects pending callers and cancels late/open response
bodies. Cancellation cannot promise reversal of a dispatched operation. The
connector still owns wire-frame/body limits, channel lifetime, authenticated
endpoint admission and its own process/socket cleanup.

Focused tests cover ordinary runtime admission, forbidden authority headers,
opaque proof preservation, cookie refusal, capacity, and retirement before and
after response headers. Bootstrap lifecycle tests control heavyweight startup;
they do not prove the full application route composition over a DataChannel.
Real encrypted SDK login, Project traffic, reconnection and native delivery
remain required before enabling the connector. This seam alone does not satisfy
those acceptance requirements.

### Native Device proof on the application channel (#2893)

**Decision for the first native pilot; server admission is source opt-in.** The Tauri host
keeps a paired Device bearer in its OS keyring and attaches it to host-owned
HTTP requests in [`src-desktop/src/lib.rs`](../../src-desktop/src/lib.rs). The
native WebRTC application client in [#2856](https://github.com/kontourai/station/pull/2856)
runs in the WebView, so that HTTP attachment does not reach its DataChannel.
Returning the bearer to JavaScript would break native credential custody.
Broker routing proof, Station signing trust, Device authority and account
continuation remain separate; none can substitute for another.

For relay-only protected requests, bind a **separate P-256 Device proof key**
at explicit operator Device approval. The account key in
[`native_account_proof_key.rs`](../../src-desktop/src/native_account_proof_key.rs)
is a custody pattern, not the Device key. The binding protocol requires the
host to mint a **provisional canonical UUIDv4 candidate binding ID** before
creating its Device proof key and include it — with the exact Station ID, the
approved Device ID, the full native
surface, and the Device public JWK plus its RFC 7638 thumbprint — in the
binding candidate it presents for approval ([contract shape](../../packages/contracts/src/native-device-proof.ts)).
The candidate carries no secret: the UUID itself grants nothing. The Station
operator explicitly approves that exact tuple for the create or revoke
operation, the server freezes the tuple, recomputes the thumbprint, and accepts
the host-proposed ID instead of minting an independent server ID. The binding
ID must be unique across active and revoked historical records before any previous binding is
replaced; retrying the exact active candidate returns its recorded state
without re-approving or recreating. Revocation must name the exact reviewed
binding ID and public key; a delayed approval cannot revoke a newer replacement
on the same native surface. Host-side reconciliation is bounded: if a
transport failure leaves the commit outcome unknown, or an exact-ID readback is
absent, the host MUST retain its provisional proof key — a binding may have
committed even when no readback confirms it. Key cleanup requires a
definitive terminal outcome or a confirmed cancellation. Station stores the Device public key,
the approved binding ID, the approved native surface and grant scope in a private
sidecar that rechecks the current paired Device. The host stores its private key in a distinct keyring namespace
bound to the selected Station, Device and binding ID. An existing bearer Device
needs an explicit operator-approved binding ceremony; a saved profile or broker
grant cannot upgrade it silently. Local solo use still needs no person account.

The Desktop source now creates or resumes this provisional candidate through
the main-window-guarded `station_native_device_binding_candidate` IPC. Under one
locked profile-store snapshot, the selected relay-route profile supplies
Station, approved trust, route grant and surface; the separately
host-authorized profile supplies the active paired Device. They must share the
same store revision, client instance and exact Station origin. The Keychain
manager persists that owner snapshot and candidate ID before provisioning the
Device proof key, then returns only the contract's public JWK and thumbprint.
It retains the initial Device-authorization epoch and resumes the same key
after reauthorization while keeping profile revision, Station, Device, trust,
route and surface exact. The IPC does not submit the candidate to the operator
route, reconcile an approval receipt, bind it to a peer session or sign
requests; no renderer caller currently consumes it. See the
[candidate producer](../../src-desktop/src/native_relay_redemption.rs) and
[candidate manager](../../src-desktop/src/native_device_binding_candidate.rs).

The request-signing protocol requires the host to sign one short-lived proof over the exact Station
audience, Station and Device IDs, binding ID, native surface, unique Pion peer
nonce, uppercase method, path **including query**, SHA-256 digest of the exact
transmitted body bytes, JTI and expiry. The WebView may carry this one-request
proof through the encrypted application channel but never receives the Device
bearer or private key. The [host peer owner](../../src-desktop/src/native_application_peer.rs)
now constructs this Device proof after verifying Station's exact signed nonce,
connection identity, both SDP digests and DTLS fingerprints. It checks current
profile/epoch, trust, grant and positively reconciled Device binding, then permits
one proof per opaque handle for the pilot's bounded method/path/query/body.
The renderer supplies no claims, hashes, signing bytes or connected assertion.
Browser RTC remains renderer-owned; a verified transcript is not proof that
DTLS is connected. Station verifies the signature
against the *current* Device grant, independently hashes the received body,
consumes the JTI before dispatch, and compares the proof's peer nonce/surface
to private Pion provenance. Only then do ordinary Device scope, account,
Project, resource and compute checks run. Direct HTTPS cookie/bearer paths
remain unchanged. A revoked Device or binding fails on every subsequent
request; account signout does not silently revoke or renew the Device.

The runtime's authenticated Request principal must name this as a distinct
native Device-proof authority. It must not place a fabricated bearer in the
existing `credential` field or let a proof inherit operator/home-possession
status. Freshness and delayed-response checks re-resolve the exact Device and
binding ID from the pairing owner; scope comes from that current grant. This
keeps a proof-bearing WebView request from entering the legacy bearer-only
paths that authorize pairing, consent or other privileged operations.

This approach reuses the existing JavaScript DataChannel and Station virtual
application ingress without a second native WebRTC implementation. A host-owned
native DataChannel could keep the bearer out of JavaScript too, but Station has
no such desktop client today; it remains an alternative if the proof protocol
cannot satisfy the packaged acceptance. Source and SDK proof tests, executed
Tauri IPC, a packaged Project read/reconnect/revoke, and physical two-person
evidence are distinct proof layers. Source registration of the candidate
command is not executed IPC or packaged/device evidence.

The current foundations are the [Device binding service](../../src-server/services/ssh/native-device-proof-binding-service.ts),
[request verifier](../../src-server/services/identity/native-device-proof-verifier.ts),
[durable replay store](../../src-server/services/identity/native-device-replay-store.ts),
and the credential-free Request principal in [runtime request security](../../src-server/security/runtime-request-security.ts).
The binding service requires an exact approved app, channel, client instance and
route-key thumbprint, with a separate Device key. Private Pion Request facts
carry the offer nonce through bounded-body replacement.

**Native proof composition (server source opt-in).** `configureRuntimeHttp`
now admits a presented Device proof BEFORE deployment-account authentication:
cheap private peer/route/rate checks, a bounded exact-body read (16 KiB) whose
bytes build the final Request and carry the private peer provenance at that one
byte-copy owner, then Device JWS/JTI admission, then Device scope against the
central route declaration, then the native account continuation controls or a
required current account session. Only the three neutral health observations
may omit account material; presenting invalid account material never falls
through to Device-only authority. A proof attempt
never falls back to a bearer or cookie; a conflicting credential, missing
private Pion provenance, unsupported configuration or non-pilot route refuses
closed. The [current allowlist](../../src-server/security/native-device-request-authority.ts)
contains native challenge/exchange/revoke and invitation acceptance POST leaves;
GET/HEAD Station health/authority, Project list/detail, shared-work list, and
scoped document/history/publication reads. Neutral Device-only observations are
`/.well-known/station/v1`, `/api/system/status` and `/api/system/identity`.
Authority and member reads still require the separate account. Privileged,
terminal, plugin, pairing, consent and generic operator routes refuse proof
authority even when the proven Device holds broad scopes. A separate closed
relay-management and Project access management inventory now has native
transport and fixed account-proof preparation; it requires explicit management
scope and independent Project IAM. The account-bound gate admits only exact
native relay-management leaves with current Device/account binding and separate
management scope; credential-only account-bound Devices remain gated.
Capabilities return neutral false without management authority. The one [native Device request
authority](../../src-server/security/native-device-request-authority.ts) mints
the credential-free principal on the final Request, and every later seam
(account-bound gate, orchestration principal, Project membership authority,
native account continuation) re-reads binding, paired Device and account
binding through it — including before and after each provider await — never
carrying identity from headers. Station-runtime composes binding, replay and
admission only behind `STATION_NATIVE_DEVICE_PROOF_PILOT=1` with a supported
provider/session capability and native connector; `0` disables the pilot and
unsupported opt-in configurations fail closed at startup. The
exchange attempt limiter is keyed by the verified Device identity, not the
absent-Authorization bucket.

**Evidence boundaries.** The production-composition suite
([runtime-routes native pilot](../../src-server/runtime/routes/__tests__/runtime-routes-native-device-proof-pilot.test.ts))
drives the real HTTP admission, real application channel and Pion adapter with
a faked peer transport, real pairing/binding/replay/membership stores and the
real local-account provider. At `07a7d02ff0`, the owning verification lane
executed 35/35 tests. Native manager coverage exercises actual surface-registry
approval/revocation and the invitation-owner call with an external broker stub.
Device approve/deny checks reach only `503 enrollment_unavailable` admission;
they do not exercise enrollment decisions. Maintained fault controls removing
native admission caused four failures; removing the native-principal condition
caused one. Both byte-exact restorations returned 35/35. Earlier prerequisite
and fixture failures remain failed diagnostics. This does not prove a packaged Tauri host, the
host-signing IPC, physical devices or a production identity provider. The
approval-context factory still does not authenticate an operator. The opt-in
runtime mounts an operator-credential-only approval/readback route that checks
current authority and the exact binding tuple. Native Device proofs, account
membership and home possession cannot approve a binding. Host Device and account
proof commands are now registered. The separate
[native Project pilot](../guides/native-shell-verification.md#native-protected-project-pilot)
exercises their real macOS debug WebView/IPC composition. Its dated frozen-harness
receipt covers protected reads, reconnect and account/Device revocation. It does
not qualify ordinary route/sign-in
UI, packaged/physical acceptance or fresh relay-only enrollment.

The opt-in runtime also mounts a [protected Device self-receipt](../../src-server/routes/system/native-device-proof-self-receipt-routes.ts)
at `GET/HEAD /api/auth/native-device-bindings/:bindingId/receipt`. Only a current
ordinary Device bearer with `orchestration:read` can observe its own exact
public binding record. This exact self-read precedes the account-bound Device
gate's account-session requirement; it supplies no account principal or Project
authority. One sidecar snapshot supplies historical state and currentness,
and the route rechecks the current bearer before publication. Missing and
foreign records have the same refusal. The mounted runtime tests cover the
account-free read, ownership, revocation, scope withdrawal and corrupt storage;
they do not establish an executed native IPC or relay-only retrieval.

The Desktop source now registers `station_native_device_binding_self_receipt`
in the [native relay owner](../../src-desktop/src/native_relay_redemption.rs).
It restores an existing candidate, reads only its fixed Station receipt URL
through the private native HTTP collector, and compares the full public tuple.
The bearer stays in Rust. The 45-second HTTP deadline includes capacity wait;
the complete response is capped at 4 KiB. Final profile/authority locks cover
owner and epoch revalidation, observation persistence and public result
construction. A nonblocking process-wide guard prevents overlapping reads from
overwriting newer observations. The host epoch is not the proof binding UUID.

Fresh matching receipts return `current` or `not-current`; a closed versioned
404 returns `not-found`. Transport outages or a versioned unavailable response
may return an earlier `cached-observation` with its original timestamp, labeling
a prior positive state `previously-confirmed-current`. Malformed or unrelated
errors remain unavailable, and every refusal retains the provisional key.
Its positive owner/epoch-bound observation is required by the peer and account
owners, but ordinary route-selection UI does not invoke it automatically. It
grants no account or Project authority. The manual pilot has executed real
host-receipt evidence on the exercised macOS debug bundle; packaged use and fresh
relay-only enrollment remain unverified.

The [application Fetch adapter](../../packages/connect/src/core/applicationChannel.ts)
now supports a channel-owned `prepareRequest` hook after peer admission. It
passes copied request bytes and headers while retaining the original target,
query and body for dispatch. Added headers cannot replace existing headers;
cancellation or failed preparation closes without dispatch. This public hook
does not activate ordinary client transport. The native bridge now consumes the
host handle lifecycle and adds the host Device proof through this hook. A lost
open reply is read through the same handle; read expiry can shorten but cannot
extend a prior deadline. Cancellation, late replies and expiry retire handles.

The independent [account operations](../../src-desktop/src/native_account_operations.rs)
and SDK typed proof provider prepare the local username/password exchange body
before the Device hook freezes/signs it. Account claims/hashes/JTI/time come from
the host, with a separate key and bounded owner-fenced context. One exchange,
full host challenge-consumption retention and post-sign expiry/key checks prevent
replay or expiry-hint laundering. Native challenge/exchange still need an already
account-bound approved Device and real supported provider login; that Device
may be paired already or come from the separately acknowledged
[native fresh ceremony](native-relay-enrollment.md). No principal, cookie or
renderer-visible Device bearer is manufactured. The manual pilot composes these owners
with real local-provider login and separately accepted Project membership.
Its dated debug-shell receipt is separate from later builds and physical
acceptance. The ordinary
[selected native owner](../../src-ui/src/platform/native/nativeRelayConnectionOwner.ts)
now supplies the [account bridge](../../src-ui/src/platform/native/nativeAccountSessionBridge.ts)
and bounded member-read consumer. Host preparation exposes a fixed deadline,
which clamps public account expiry; fixed remote logout clears local account
scope on confirmed or unknown outcomes while preserving Device custody. Only a
confirmed provider-revocation acknowledgment establishes remote completion.

### Transport qualification

The [browser transport evaluation](../guides/local-collaboration-lab.md#browser-transport-evaluation)
establishes a candidate mechanism for the browser boundary: WebRTC DataChannels
carry application data over SCTP/DTLS, while TURN forwards traffic without the
endpoint private keys. This uses the browser's authenticated transport rather
than introducing an application cipher. See [RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html).

The current evaluation is a **go for further protocol integration, defer for
production transport selection**. Real Chromium/Node UDP relay delivery and
certificate-substitution rejection pass; that packaged Node backend's TURN/TCP
interoperability does not. The independent Pion profile uses a maintained Go
implementation with TURN/TCP and the same browser DTLS rejection checks;
qualification of that profile does not silently qualify the Node backend.
[#1995](https://github.com/kontourai/station/issues/1995) owns qualification of
that path before production adapter selection.
The fixture installs approved fingerprint trust out of band. It does not deliver
the production enrollment, signed signaling, recovery or client-distribution
contract above. Node TLS pinning in the original fixture likewise does not
establish browser transport support. Keep these receipts distinct, and do not
enable managed connectivity from a passing transport-only test.

Contract checks cover wrong account/Station/audience, replay, stale allocation,
key rotation, renewal, revocation, callback origin, redirects and endpoint
substitution. The actual selected transport must prove reconnect, restart,
partial allocation recovery, credential renewal and an independently working
direct path. Keep metadata/push payloads out of content logs.

Before #1963 enablement, record the chosen transport/provider, signing trust,
evidence of the accepted confidentiality requirement, credential and revocation
bounds, self-host packaging and operational owner. The free local lab is a
required delivery path alongside actual selected-transport acceptance, not a
substitute for it. This proposal makes no infrastructure purchase,
production exposure or service-level commitment. Protocol fixtures cannot prove
actual remote delivery or a transport provider's security boundary.

### Superseded native routing scope observation

The [broker guide](../guides/self-hosted-broker.md#authenticated-observation-of-a-superseded-native-scope)
owns the invitation-authenticated observation contract. A live, unconsumed
current invitation and its bound installation key can observe only that an
exact strictly older scope in the same Station/enrollment cannot admit a
native grant. This observation does not prove grant existence or individual
revocation, redeem the invitation, rotate signing trust, or authorize any
application request. Equal-generation expiry and missing grant rows remain
outside this recovery basis. Native local cleanup must separately retain
explicit owner confirmation, durable basis and exact custody fences.
