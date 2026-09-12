# Design: Station topology and role vocabulary

> Status: **decision record, documentation-only** for
> [#479](https://github.com/kontourai/station/issues/479), recovered from
> [archived PR #4377](https://github.com/kontourai/station-archive/pull/4377) and
> regrounded on 2026-09-12 at `8c85f6b10bd2ad5e0c19172d13613a39535b811f`.
> This record changes no runtime, wire contract, persisted schema, identifier,
> grant, deployment configuration, CLI, or API. Follow-on implementation must
> make its own compatibility and migration decision.

## Decision

Station is not a physical machine. A physical machine can run zero, one, or
many isolated Station instances; an instance can be reached at several
endpoints and from several Devices. The roles below describe where a fact is
owned or performed. They never enable a capability or grant authority.

Keep **Client** for the agent apps a Station runs, and **Device** for the
phone, laptop, or browser a person uses to reach it. When architecture needs
the network-side phrase, write **Station client role** in full: it describes an
implementation initiating a connection to a Station and is never a
user-facing substitute for Device or the existing Client noun.

| Thing | Cardinality and identity | What it answers | Authority and availability |
| --- | --- | --- | --- |
| **Physical machine** | One machine can host zero or many Station instances; one person can use many machines. It has no Station identity by itself. | Where a process, files, or a local model happen to run. | Topological fact only. A machine does not grant access to its files, credentials, agents, or inference. |
| **Station instance** | One owned core server process with its own lifecycle, ports, and Station home; several can coexist on one machine. | Which Station process answered or owns local state. | The instance registry records process/lifecycle facts. `command-station` remains the exact component discriminator for the server runtime. |
| **Saved Station entry** | A client-local, renameable record, identified locally and allowed to be merged or forgotten. Many entries can point at one Station. | Which Station this Device intends to reach, at which endpoint, with which credential reference. | Local routing configuration only; forgetting it removes no server state and does not identify an execution target. |
| **Authenticated environment** | Server-owned `environmentId`, stable with the Station home across process restarts. Discovery may advertise it, but an authenticated connection must verify the intended environment. Multiple endpoints may identify one environment. | Which reachable Station environment the server authenticated. | Handshake identity, not a person, tenant, Project, or capability grant. |
| **Endpoint** | An origin/access path; one environment can have many and an endpoint can change. | How this request reaches an environment. | Reachability only. An endpoint or SSH tunnel neither proves identity nor starts a process. |
| **Principal** | The landed resolver attributes a verified identity as `human:<provider>:<subject>`, a verified home-possession or operator-credential caller as `human:local:operator`, or a bound hosted deployment as a tenant principal when no human identity is present. | Who acted. | Attribution is distinct from tenant routing and from a Device credential. Task-room request authority consumes the resolved `PrincipalRef.id`; independently authorized human membership remains target work. |
| **Tenant** | A deployment/customer boundary selected from exact request authority; one deployment can configure many. | Which hosted deployment partition a request belongs to. | `TenantId` is not a human, organization membership, account, or grant. Current hosted tenancy is not multi-user readiness. |
| **Project identity** | One portable opaque Project id can be realized by many local checkouts and participate in rooms. | Which shared workspace/resources are meant. | Identity/reference authority in the Project manifest; never derived from a local path, machine, or display name. |
| **Project binding** | Per Station and per member (currently the member is implicit); a Project can have zero or many local realizations. | Where a named Project resource resolves locally. | Private local resolution state. It is not membership, consent, a portable manifest field, or an execution offer. |
| **Room authority** | Current personal Task-room history is sequenced by one local Station worker. Target shared rooms have one control-log home at a time; copies and members may be many. | Who can sequence a room's committed history. | Current `leaseRef: 'station-local-l0'` is a label/reference, not a verified lease or fencing service. Witnessed promotion requires a real verified lease; peer-only rooms freeze. Authority metadata never travels in the portable Project manifest. |
| **Execution offer** | A Station may make zero or more explicit, scoped contributions in the execution, agents, or inference axes for a Project/resource. | Whether that Station has opted into the relevant execution, agent, or inference path. | Separate, revocable consent evaluated by the relevant runtime path. Files and credentials stay runner-local dependencies scoped by execution authority; they are not offer contents or transferred material. Viewing or joining never creates an offer. |

### Roles are relationships, not types

- A **Project home** is the descriptive location/authority role for a Project's
  shared control record or room. It is not the Home screen, a plugin role,
  `STATION_HOME`, or a local `projectHomeDir` path. Those remain separate UI,
  extension, Station-home, and binding concepts.
- A **runner** is a Station instance that has an accepted execution offer and
  can perform the requested work through an authorized execution path. A
  runner can be co-located with a Project home, but neither label implies the
  other.
- An **inference provider** supplies token generation only when separately
  contributed and granted. It is not thereby a runner and it receives neither
  workspace files nor agent/tool authority.
- A **viewer** may receive the read/discussion access that a room authorizes.
  Viewer status never offers local compute, files, credentials, agents, or
  inference.

## Current and target availability

| Relationship | Current, source-backed availability | Target boundary |
| --- | --- | --- |
| Personal control from another Device | Device pairing reaches a Station with a scoped, revocable credential. | It remains personal control until independent-human membership is delivered. |
| Local, enrolled-peer or SSH remote execution | A Station can delegate execution to a remote Station using its outbound scoped credential, directly or over SSH; the target owns its agents, workspace, credentials, and event record. | Project-specific consent and role discovery require their own runtime work. |
| Fleet inference | A contributed local model can serve completions to another authorized Station. | It remains tokens only, never a general execution offer. |
| Two independently authenticated people in one Project/room | Not available as a completed capability. | Gated by [#488](https://github.com/kontourai/station/issues/488) and the wider room/member contract in [#580](https://github.com/kontourai/station/issues/580). A non-contributor may eventually read or discuss only through an explicit grant. |
| Organization fleet and customer-owned runner | Not available as a completed capability. | Gated by #580's tenant-safe membership, room, store, and contribution work; deployment-role discovery is separately owned by [#480](https://github.com/kontourai/station/issues/480). |

No role label is evidence of a live capability. A later capability surface must
distinguish build support, operator declaration, observed service readiness,
and caller authorization; absent evidence remains unavailable or unknown.

## Compatibility and authority boundaries

Existing records keep their existing meanings. In particular, a Saved Station
entry remains a local endpoint/credential-reference record (`StationProfile`
is its contract identifier);
`KnownEnvironment.id` remains local while `environmentId` remains server-owned;
`TenantId` remains exact deployment authority; and `command-station` remains
the server component discriminator. This decision does not reinterpret any of
them or require a migration.

The Project manifest carries portable identity and references. A local binding
answers whether this Station realizes a resource. Membership answers who may
participate in a room. An offer answers what a Station voluntarily makes
available. Current personal-room sequencing is local and has no lease service;
only a future witnessed room lease can fence who may sequence its control log.
These facts must remain independently authored, revocable, and checked at the
boundary that consumes them.

Consequently, observing a Station, joining a Project, viewing a room, or
holding an endpoint does not authorize local compute, files, credentials,
agents, or inference. Conversely, a local binding or a reachable endpoint does
not make its owner a Project member or a room authority.

## Worked examples

1. **Solo, co-located.** One laptop runs one Station instance. Its local
   Project binding resolves a checkout, and the same instance may be the
   Project-home and runner role. That coincidence is a local default, not an
   identity rule; its `STATION_HOME` is still only the instance's data home.
2. **One machine, isolated Stations.** A workstation runs a stable service and
   a worktree instance on different homes and ports. They are two Station
   instances even though the physical machine is one. A Device can save either
   or both as separate Stations; neither profile name decides which instance
   owns a Project binding.
3. **Personal remote execution versus inference.** A laptop delegates a task
   to a workstation through its remote-Station path. The workstation runs the
   agent with its own workspace and credentials. In a different request, the
   laptop uses an explicitly contributed workstation model for completions;
   the laptop keeps the agent loop, tools, files, and task record. The latter
   is not remote execution.
4. **Two people, one non-contributor.** In the target #488/#580 model, Alex
   and Bea are distinct principals in one Project room. Bea can be granted
   view/discussion access without a local checkout and without becoming a
   runner. Alex's Station may offer a bound checkout for execution, but that
   offer is separate consent and does not follow from either person's room
   membership. This is not current runtime behavior.
5. **Organization and customer-owned runner.** In the target hosted model, an
   organization can have several Station instances while a customer owns an
   independent runner. Exact tenant routing selects the deployment boundary;
   member grants select room actions; the runner must explicitly offer the
   requested Project resource. None of those facts is inferred from the
   organization's name, the customer's endpoint, or a machine path. This is
   gated target work, not a hosted-capability claim today.

## Follow-on ownership

This record intentionally has no schema migration. Runtime role publication
and reconnection semantics belong to #480; independent-human room authority
belongs to #488 and #580; and future Project-home recovery must make its own
authority/fencing decision. Any implementation that adds a wire or persisted
role must declare its compatibility behavior rather than treating this
vocabulary decision as an implicit migration.


## A Project shared with a coworker

This is the required target journey, not a claim that membership is already
available. An owner invites a coworker to one Project. The coworker's Device
connects to the authoritative Station; authentication resolves a principal;
Project membership decides what that principal may see and do. A principal is
never an endpoint a Device connects to.

The owner grants viewing, discussion, editing, starting work, approval and
administration separately. The coworker sees Project-shared work and can start
separately attributed work when allowed; private conversations and unrelated
Projects stay outside that grant. Permission to start work does not grant use
of every computer, unrestricted terminals or access to provider credentials.
The receiving computer must offer the requested resources explicitly.

One person may use several Devices. The explicit person-binding pilot is
tracked in [#1513](https://github.com/kontourai/station/issues/1513); existing
per-device identity must not silently stand in for that binding. Joining needs
no checkout, local agent engine or compute contribution. Device revocation and
Project membership removal are different operations. Future admission/delivery
must stop when access is revoked, while already-started effects and downloaded
plaintext retain their disclosed limitations.

## Broker and plugin placement

A connection broker helps a Device discover and reach a Station. A tunnel
carries traffic. Neither becomes the Project's application authority or grants
membership. Existing direct/tailnet/SSH paths remain independently usable; a
managed path depends on its broker renewal and tunnel availability. The design
and implementation owners are [#45](https://github.com/kontourai/station/issues/45)
and [#1963](https://github.com/kontourai/station/issues/1963).

A plugin package can contribute code at several locations:

| Fact | Owner or location |
| --- | --- |
| Installed package/version | The selected Station installation; reviewed bytes are distinct from writable data |
| Enabled contribution | The permitted Project or Agent composition |
| Pane interface | The viewing Device, with its explicit UI isolation/trust policy |
| Server module | The Station server process today; raw Node authority is not a Project sandbox |
| Agent/tool work | The authorized execution computer or external tool service |
| Persistent data and secrets | Their separately scoped storage/credential owners |
| Permission to use or administer | Current member/device/contribution/resource policy |

Installing or viewing a plugin does not grant every member its capabilities or
install its server code onto the viewing Device. Identical package versions do
not justify shared tenant data or credentials. Isolated tenant application
runtimes are the first managed direction; membership and actual code isolation
remain separate requirements under [#487](https://github.com/kontourai/station/issues/487)
and [#490](https://github.com/kontourai/station/issues/490).

## Plain-language explanation

"A Station keeps your projects, conversations and agent work together. Open it
from any Device. Connect computers when you want them to run work. Share a
Project with a coworker and choose what they may see and do. Plugins add
capabilities, with explicit access to the Projects and resources they need."

This explains the intended product without making server, relay or tenant
customer-facing setup choices. It does not rename existing public contracts.
Use qualified terms in technical material: Station client role, computer host,
pane host, Station data home or Project home. The Home screen remains a screen.


## Source owners

- [Environment/security service](../../src-server/services/ssh/environment-security-service.ts)
  and [KnownEnvironment](../../packages/contracts/src/known-environment.ts):
  stable identity, proof, routes and the non-secret discovery projection.
- [Delegation](../../src-server/tools/station-control-delegation.ts) and
  [remote session reads](../../src-server/services/ssh/remote-session-reader.ts):
  destination-owned execution and authenticated aggregation.
- [Principal resolution](../../src-server/services/identity/principal-resolver.ts)
  and [tenant context](../../src-server/runtime/bootstrap/runtime-tenant-context.ts):
  actor attribution and verified deployment routing.
- [Plugin installation](../../src-server/services/plugins/plugin-installation-service.ts)
  and [server modules](../../src-server/services/plugins/plugin-public-server.ts):
  storage/lifecycle boundaries and current in-process code authority.
