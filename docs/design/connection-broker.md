# Optional Station connection broker

> Status: proposal for [#45](https://github.com/kontourai/station/issues/45).
> [#1963](https://github.com/kontourai/station/issues/1963) owns implementation
> after identity, trust, confidentiality and provider decisions. No broker,
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
| Tunnel provider | Traffic transport; its confidentiality properties must be chosen explicitly |
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
after its confidentiality and operating ownership are approved. Do not invent
an encryption scheme or a second identity product. The self-operated two-person
Project pilot proceeds over existing access paths independently.

## Acceptance and decisions

Contract checks cover wrong account/Station/audience, replay, stale allocation,
key rotation, renewal, revocation, callback origin, redirects and endpoint
substitution. The actual selected transport must prove reconnect, restart,
partial allocation recovery, credential renewal and an independently working
direct path. Keep metadata/push payloads out of content logs.

Before #1963 enablement, record the chosen transport/provider, signing trust,
content visibility/E2EE policy, credential and revocation bounds, self-host
packaging and operational owner. This proposal makes no infrastructure purchase,
production exposure or service-level commitment. Protocol fixtures cannot prove
actual remote delivery or a transport provider's security boundary.
