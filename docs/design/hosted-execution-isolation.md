# Hosted execution and plugin isolation

> Status: proposed boundary for [#487](https://github.com/kontourai/station/issues/487).
> The accepted direction is isolated Station application runtimes and scoped
> execution. This document does not select a cloud provider or establish a
> tested sandbox. [#494](https://github.com/kontourai/station/issues/494) owns
> managed operation after the isolation and recovery exits.

## Three independent boundaries

**Customer isolation** prevents one deployment tenant from observing or
controlling another. **Project membership** controls people within a tenant.
**Execution isolation** bounds a job, agent or plugin to its allowed resources.
One cannot replace another. A dedicated customer process does not authorize
all coworkers to use every tool; a membership check does not confine Node code.

A local Station may co-locate work authority and execution. For the initial
managed offering, separate tenant application runtimes, private homes, service
identities and writable state. Shared connection/identity infrastructure remains
outside tenant plugin and agent execution. A computer may run several isolated
instances; an organization need not equal one tenant or computer.

## Source boundary and reuse

[StationRuntime](../../src-server/runtime/bootstrap/station-runtime.ts)
constructs one home, configuration owner and orchestration store, and holds a
home runtime lease. [Hosted persistence checks](../../src-server/runtime/bootstrap/hosted-persistence-boundary.ts)
validate storage ownership; they are not an arbitrary-code sandbox.
[Session authorization](../../src-server/services/orchestration/session-authorization.ts)
checks persisted tenant/owner bindings. Plugin routes and grants are composed
around a home rather than a complete per-member/per-tenant storage interface.

[Plugin server modules](../../src-server/services/plugins/plugin-public-server.ts)
are imported into the Station process. Their lifecycle and digest grants gate
admission, but raw Node code can use the process's ambient filesystem and
network authority. An added host API does not remove that authority.
[UI frames](../../src-ui/src/components/plugins/PluginFrameHost.tsx) separate
plugin UI from the shell; that is not server-side or per-tenant confinement.

Reuse [installation state/materialization/data interfaces](../../src-server/services/plugins/plugin-installation-service.ts),
[retained plugin generations](../../src-server/services/plugins/plugin-incarnation.ts),
[content-bound grants](../../src-server/services/plugins/plugin-permissions.ts),
and [secret child establishment](../../src-server/services/secrets/mcp-secret-child-env.ts).
The [composition module](../../src-server/services/plugins/plugin-composition.ts)
reserves core identity/authorization/evidence authorities, but its standalone
factory is not proof of a production composition path. Preserve the existing
engine confinement owner and scoped execution contracts rather than replacing
them with a new framework.

## Proposed placement policy

| Contribution | Placement and authority |
| --- | --- |
| Package bytes | Immutable reviewed artifact; reuse only where licensing and acquisition policy permit |
| Installation and grants | Owned by exact Station/tenant installation and revision |
| Project activation | Explicit member-authorized contribution selection; package availability is not use authority |
| UI pane | Viewing device, isolated through a constrained host contract by default; full shell trust is explicit |
| Trusted administrative server module | Only within the tenant's deliberately trusted application boundary |
| Untrusted plugin service or agent job | Separate enforced execution boundary, with scoped host calls |
| Writable plugin data | Installation-owned stable data scope; updates do not silently reset it |
| Provider/tool credentials | Operation/integration-scoped resolution; no shared broker custody or general secret enumeration |
| Background observer | Durable tenant/Project/installation/standing-grant binding, reauthorized at delivery |

The same package version does not justify sharing module globals, configuration,
data, credentials or event cursors. Read-only package caching must not become a
shared writable execution cache. A viewing device does not acquire server-module
code execution merely because it displays a remote plugin pane.

## Execution boundary selection

Use an OS-enforced isolation boundary for mutually untrusted code. Compare
VM/microVM isolation with containers against the actual workload and operators'
trust assumptions. A container sharing the host kernel requires an explicit
justification and tested restrictions; a Node worker, module loader, VM context
or a separate directory is not that justification.

Before launch, bind exact tenant, actor/delegator, Project, installation and
code generation, workspace, contributed tool/model capabilities, secret grants,
resource reservation and attempt identity. The receiver checks its own current
authority. An untrusted caller cannot construct the trusted execution context
by supplying those fields in JSON.

Deny ambient host files, other tenants' volumes, privileged sockets, cloud
metadata credentials and uncontrolled writable caches. Bound CPU, memory,
process count, storage, wall time, concurrency and network egress. Grant the
specific required resources; do not mount a Station home into arbitrary code.
Expose only the reviewed host-operation interface, not a general credentialed
HTTP proxy or the application database credential.

Unsupported isolation fails before external start. After a possible start,
timeout/disconnect is an indeterminate execution outcome, not permission to
release its reservation or launch again. Drain stops new work; removal waits
for proven termination and retained result/receipt publication. A process ID
without its ownership/birth evidence is not termination authority.

## Membership and plugin enforcement

[Project membership](project-membership.md) supplies the actor's action limits.
Execution contributions, device scopes, current plugin grants and Project
resource policy further restrict them. Installing a plugin is distinct from
letting another member execute it. A customer administrator accepting full-trust
server code accepts that tenant boundary's authority; the product cannot also
claim the code is confined to a read-only Project API.

For finer plugin isolation, move untrusted server contributions behind a
separate process/OS boundary and a narrow capability protocol. Reuse existing
installation generations and admission leases to reject stale invocations.
Revocation prevents new effects where they can be interposed; cancellation of
already-running provider code is reported with actual termination/unknown state.
No receipt can retract effects already completed or plaintext already delivered.

## Tenant storage and lifecycle acceptance

[#490](https://github.com/kontourai/station/issues/490) must cover configuration,
installation records, grants, activation instances, knowledge, search, background
subscriptions, secrets, artifacts and backups at their owning stores. Scoped
request middleware cannot make a shared unscoped store safe. Keep current hosted
terminal/scheduler and other unsupported paths unavailable until their whole
transport/storage/background chain is qualified.

Required real-runtime experiments:

- Two tenants use the same plugin version and colliding resource ids; neither
  can read, change, subscribe to or export the other's state or secrets.
- Two people within one tenant have different Project permissions; a plugin
  action and an agent job cannot substitute the owner's greater authority.
- Jobs attempt cross-workspace filesystem/process access, credential discovery,
  metadata-service access, unauthorized network egress and resource exhaustion.
- Revoke membership, plugin grants and compute offers during pending work;
  distinguish refused admission, requested cancellation and proven termination.
- Restart, update, partially provision, fail cleanup and restore from backup;
  retain exact ownership and reject stale cleanup against replacements.

Source/fixture tests accompany these experiments but do not substitute for them.
The first acceptance run is in isolated test infrastructure with deliberate
operator authority. Cloud purchasing, production tenancy and service commitments
require their separate decisions. Initial independent-human collaboration over
existing self-operated access is not blocked on this managed deployment.
