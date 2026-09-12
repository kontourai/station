# Project membership and device enrollment

> Status: initial verified-tailnet identity and explicit device binding approved
> by the owner on 2026-09-12 for [#1513](https://github.com/kontourai/station/issues/1513).
> This document specifies the contract; it does not claim implemented API or
> membership capability. [#488](https://github.com/kontourai/station/issues/488)
> owns implementation and [#497](https://github.com/kontourai/station/issues/497)
> owns the two-human acceptance journey.

## Outcome and vocabulary

An owner shares one Project with a collaborator. The collaborator can see
Project-shared work, contribute where permitted, and start independently
attributed work on separately approved compute. Joining does not offer the
collaborator's files, credentials or computer. A viewing device needs neither
an agent engine nor a checkout.

Use **Device** for what connects and **Station** for what it connects to, as
[the glossary](../glossary.md#station-device-client) requires. In this document,
"client software" means the UI/SDK on that device, not the glossary's **Client**
(agent app). A principal is the actor identified by authentication; it is not
a connection destination. A Project is the scope of participation. A computer
is a possible execution location, not a person or a membership record.

| Relationship | Cardinality and authority |
| --- | --- |
| Person and devices | One person may bind several independently revocable device grants |
| Computer and Stations | One computer may operate several isolated Station instances |
| Person and Projects | One person may have different membership in each Project |
| Project and computers | A Project may use multiple explicitly offered execution locations |
| Organization and tenants | An organization need not equal one tenant, Station or computer |
| Package and installation | The same package may have independently owned installations and data |

A local Station may manage work and execute it in one process. A peer receiving
an ordinary delegation owns that execution Session; inference-only sharing
leaves the caller's agent loop and Session in place. Neither path establishes
membership. See [peer pairing](station-peer-pairing.md) and
[portable Project identity](portable-project-identity.md).

## Current seams and limits

[PrincipalRef](../../packages/contracts/src/principal.ts) already separates
human, agent, service and tenant attribution. The
[request composition](../../src-server/runtime/routes/runtime-routes.ts)
currently prefers verified ingress identity, then verified operator authority,
then device identity. Consequently, the same device can resolve to a tailnet
principal on one route and a device principal on another. A device principal
is useful attribution but is not evidence that several devices belong to one
person. [Identity sources](identity.md) remain provider-qualified.

[SessionAuthorization](../../src-server/services/orchestration/session-authorization.ts)
checks persisted tenant and owner bindings. It does not by itself authorize a
second member to read the owner's Session. A Project-sharing implementation
must add an explicit shared-resource authorization path; weakening the owner
check globally would expose private work.

The [pairing service](../../src-server/services/ssh/device-pairing-service.ts)
stores device grants and verified requester provenance. Provenance is not yet
an explicit, current person-to-device binding. The
[tenant middleware](../../src-server/runtime/bootstrap/runtime-tenant-context.ts)
authenticates deployment routing; a tenant-only principal cannot satisfy a
human-specific membership action.

## Recommended first identity contract

Use the existing verified Tailscale Serve identity source for the bounded
self-operated two-human pilot. Require distinct verified subjects for the two
people. Keep single-operator local use available with no external identity
provider. Hosted Kontour accounts remain a separate adapter under
[#489](https://github.com/kontourai/station/issues/489), after its external token
contract is approved. Cloud IAM authority never substitutes for Station access.

Add a durable, server-owned **device-to-principal binding**, separate from the
wire scope string and Project membership. Its semantic fields are:

- exact Station identity and device-grant identity;
- the existing provider-qualified human PrincipalRef;
- a unique approval identity, with active/revoked state derived from the device grant;
- issuer/source evidence, the approving actor and operation identity;
- approval time and revocation through the associated device grant.

The initial binding lasts until that grant is revoked or replaced; pairing
offers expire after their existing bounded window. This is not a promise to
observe identity-provider account revocation while the device connects directly.
A finite binding/reauthentication policy is a later explicit contract change.

This is a proposed persisted contract, not a new public PrincipalRef grammar.
Clients cannot supply a trusted binding object. Establish the binding only
when the pairing request captured verified ingress identity, the device proves
the one-time offer exchange, and an authorized Station operator explicitly
approves the link. The operator approves the captured verified subject, not a
subject supplied in the confirmation request. Use a one-time, short-lived challenge tied to that Station, device,
subject and action. Verification, replay consumption and publication must have
one durable completion boundary; an uncertain result is inspected, not replayed
as a second grant.

On later direct/SSH connections, a valid device grant plus its active binding
resolves to the same human. If a current verified ingress identity disagrees
with the binding, refuse and require explicit relinking; never choose whichever
identity has more access. A device with no binding retains existing personal
behavior, but cannot masquerade as a verified shared-Project member. Sharing an
operator credential is not the enrollment path.

A second device repeats this proof for the same human. A person removing a
device revokes that device binding/grant without deleting Project membership.
Removing membership prevents that person's access from every device. Account
linking between identity providers requires a separate explicit ceremony;
matching email, display name, machine name or local path is insufficient.

Legacy events keep their original author. A new binding changes future acting
identity, not the authorship or access class of old work. Historical Session
access or account migration requires an explicit resource policy; no global
alias makes every device-owned Session shared.

## Membership, invitations and shared resources

The authoritative Station stores membership against exact Project identity,
with a revision, current status, principal and allowed actions. A slug alone
is not portable Project identity. Begin with an exact Station/Project binding;
consume portable identity only where its existing contract is available.

An invitation names one Project, an intended verified recipient, a bounded
permission offer, expiry and the authorized inviting principal. Possession of
an invite is permission to attempt acceptance, not membership. Acceptance
requires authenticated recipient identity, current inviter authority, an active
Project and unconsumed invitation. Consume and record membership atomically.
Do not auto-join from a link preview, email match or broker account listing.

The initial action model distinguishes viewing shared work, discussion,
document editing, starting work, approving work, managing members, managing
extensions and managing compute contributions. Friendly role presets select
these actions; they are not tokens appended to device pairing scopes.
Only an authorized owner/admin may grant actions within their grant authority.
Reject removal of the last active owner unless ownership transfer commits first.

Private Sessions remain private by default. New Project work must explicitly
record whether it is Project-shared. Sharing existing work requires a review
of the selected conversations, artifacts and resource references; selecting a
Project does not publish every file in its working directory. Store a trusted
resource-to-Project/visibility binding rather than accepting public metadata as
ownership. Keep author identity separate from read access policy.

## Shared access must not inherit personal-device breadth

Existing personal device presets can reach host-wide API surfaces; they are
not safe guest credentials merely because the request now has a person id.
Before enabling the first collaborator, either provide a bounded Project-only
access surface and credential breadth, or finish member-aware authorization for
every reachable surface. Keep Project actions separate from wire scope tokens
and do not widen an existing default preset.

The first member journey must refuse unrelated Project/configuration/plugin
listings before their data is read, not hide them only in the UI. A reduced
shared-Project interface may expose only the operations already qualified;
ordinary Station UI bootstrap must not be made to work by handing the member
an operator or broad personal credential. #488 owns that admission and #490
owns the wider store inventory.

## One composed authorization decision

An action is allowed only when all applicable conditions hold:

1. The request resolves to the current authenticated principal and tenant.
2. The device grant permits the operation and is not expired or revoked.
3. Current Project membership allows the requested action.
4. The exact resource belongs to the selected authorized scope and visibility.
5. An extension action has the current installation/contribution grant.
6. Execution uses a receiver-approved contribution, workspace and budget.

An agent records its own identity and the person/standing grant authorizing
its action. It never acquires the owner's broader permissions by executing on
the owner's computer. A member may start work without receiving terminal
access. Permission to use an agent is not permission to read its credential.

Implement the decision at the owning service/store seam and reuse it across
HTTP, CLI, MCP, live streams and background delivery. A route's tenant header,
a client-supplied role, or a plugin-supplied permission name is not authority.
Missing, stale and unavailable authorization fail closed with distinguishable
outcomes. Recheck after asynchronous preparation and immediately before the
commit or external effect; record the actual membership/grant revision used.

## Revocation and concurrent work

Use revisions to prevent a stale invite or grant update from restoring revoked
authority. Reads, replay pages, search results and subscriptions reauthorize
before delivery. Pending mutations reauthorize at commit. Device/account
switches must discard reusable authorization state and cannot redirect queued
work to a same-named Project on another Station.

Membership revocation stops new admission and future delivery. Request
cancellation of active execution and report its actual result. A provider that
already accepted work may continue producing effects; a cancellation request
must not be reported as proof it stopped. Interposable tool effects reauthorize
at their own boundary. An engine without enforceable per-effect revocation
cannot advertise immediate revocation of already-running work. Record that
capability limitation before offering it to shared Projects.

Retain immutable authorship and execution receipts. Already downloaded
plaintext cannot be recalled. A disconnected client does not authorize a new
Project home, duplicate execution or migration to another computer.

## Delivery and proof

1. Implement binding/invitation/membership storage and the composed service
   boundary with real persistence, replay and revision-race tests.
2. Integrate request principal resolution and shared-resource admission without
   broadening existing owner-only Session reads. Add read/discuss first.
3. Integrate edits and separately authorized execution, then plugin actions and
   scoped computer contributions. Keep unavailable operations explicit.
4. Run the real two-person journey from #497: viewer refusal, contribution,
   separate concurrent work, two devices for one person, private-resource
   refusal, wrong-tenant/Project ids, revoked membership, expired/replayed
   invitation, conflicting identity, runner loss and duplicate submission.

The tests must exercise route/service/store/background callers, not just role
helpers. Device and provider evidence remain distinct from fixture checks.
The pilot requires an actual second human identity; two tabs sharing one
credential do not meet acceptance.

## Initial implementation boundary

The pairing approval route accepts an optional `bindVerifiedIdentity: true`.
An operator credential or a freshly verified local-grant operator may select it
for a device request carrying verified tailnet provenance. The server derives
the subject and approving principal; neither is accepted from JSON. The ordinary
bodyless approval remains device-only. The request id, proof and existing offer
expiry bind the one-time exchange; binding and device credential are persisted
atomically in the paired-device registry.

Host pairing UI exposes a default-off checkbox for verified tailnet requests.
Bound credentials resolve the same person over direct connections; conflicting
ingress identity is refused. Revoke the device or explicitly re-pair to change
its binding. Legacy grants and historical attribution remain unchanged. Hosted
binding is refused until tenant-safe device custody is implemented. Project
membership, invitations and shared-resource permissions above remain separate
work under #488; this initial slice does not enable shared Projects.

The optional stored field is additive for current unbound registries. Older
strict registry readers reject bound records; do not downgrade an active home
containing bindings to a server that does not understand them.

## Owner decision

The owner approved the initial verified-tailnet identity plus explicitly
approved device binding for the self-operated pilot on 2026-09-12. This chooses an identity
and approval contract; it does not authorize new hosted identity providers,
cloud purchases or production deployment. Until implemented and verified,
existing pairing remains the supported path and shared-human membership stays
unavailable. [#1513](https://github.com/kontourai/station/issues/1513) records
the decision; this document owns its implementable semantics.
