# Optional Station connection broker

> Status: architecture proposal for [#45](https://github.com/kontourai/station/issues/45).
> The owner accepted delegated security judgment and required a free local test
> path on September 12, 2026. Intermediary confidentiality and local testability
> are requirements; transport selection and implementation remain open.
> [#1963](https://github.com/kontourai/station/issues/1963) owns implementation
> after the remaining identity, signing-trust and transport decisions. No broker,
> tunnel service or internet-facing Station deployment is delivered here.

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

[T3 Connect at the inspected revision](https://github.com/pingdotgg/t3code/blob/18d8cbfd920d0a53e5b5206456585aea767e852c/docs/internals/t3-connect.md)
separates its hosted broker from normal traffic. Its environment supervises
cloudflared; the client uses the tunnel endpoint after bootstrap. Credential
renewal may need the broker again. Its relay implementation depends on its own
contracts, client runtime, Effect, Clerk and Cloudflare provisioning. Reuse
mechanisms and failure cases rather than importing that application wholesale.

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
core protocol. This is a delivery requirement, not an available command today.

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
