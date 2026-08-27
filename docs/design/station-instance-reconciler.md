# Station instance reconciliation

`StationInstanceReconciler` is the Module for a Station service instance. Its
Interface is deliberately small: `inspect(ref)` returns one versioned
`InstanceState`; `reconcile({ ref, desired })` converges only `running` or
`stopped`. Installation and upgrade remain separate Modules, and destructive
home reset is not a desired state.

The platform Adapter owns the implementation facts behind that Interface:
manifest presence, orphaned registration, supervisor state, the exact
authenticated Station identity, readiness, and configured ports. `station
service status` only renders the returned `InstanceState`; it does not issue a
second process probe or reinterpret a platform status record. A stopped state
requires both an inactive supervisor and an absent exact identity, so a
stranded live process is never called stopped merely because its supervisor
has gone inactive.

`not-installed` is a typed reconciliation outcome, emitted only when inspection
coherently observes no manifest, no platform registration, an inactive
supervisor, and no exact identity. The CLI maps only that outcome to its
install guidance. An absent manifest paired with a probe failure, orphan, or
live identity remains a generic failed outcome so callers cannot hide an
unsafe state behind installation advice.

## Contention and deadlines

Calls for one normalized instance id are coalesced in the process. The
production Adapter also takes one filesystem lock at
`<base>/service/<instance-id>.reconcile`. The name is derived from the already
normalized instance id, is contained under Station's owner-only service
directory (mode `0700`), and the lock file itself is mode `0600`. This is an
instance-scoped lock: distinct instances can reconcile concurrently; it is not
a broad home lock. The shared lock implementation verifies live ownership,
recovers only stale owner records, and removes its owned record on settlement.

`deadlineMs <= 0` returns `timed-out` synchronously before acquiring that lock,
inspecting, or starting an action. Positive deadlines are monotonic absolute
deadlines: the Implementation checks them immediately before and after lock,
inspect, action, readiness, and post-action inspection phases, so a blocking
synchronous Adapter cannot be mistaken for convergence merely because it
starves a timer. The deadline uses an owned referenced timer (and its linked
AbortSignal is passed to each Adapter), so a standalone CLI with a never-
settling Adapter still emits its total outcome instead of exiting on an
unsettled await. A deadline before any platform action is a `timed-out`
outcome. Once start or stop has begun, a timeout, failed readiness, or failed
post-action inspection is `partial`: ownership of the external state is
uncertain and callers must inspect again rather than retry speculatively.
If an Adapter ignores cancellation, reconciliation keeps both its process-wide
coordination and filesystem lock until that Adapter promise settles. An
opposing desired state is therefore `contended` during that uncertainty rather
than issuing an unsafe second platform action.
An immediate owned-lock release failure is returned as `failed` before action
or `partial` after action; delayed cleanup failure is logged with the already
partial uncertainty rather than being silently discarded.

Same-desired callers share the underlying work but not its deadline: each
caller waits only until its own absolute deadline. A short caller returns
`timed-out` before an action begins or `partial` after it begins; it never
cancels the owner or releases the owner's lock. Status JSON remains compatible
with the public `manifest`, `unit`, and `instance` projections (including
`unit.active`, `instance.healthy`, and `instance.instanceId`), all derived from
the single typed `InstanceState`.

`uninstall` remains a separate fallback operation: it can remove an orphaned
platform registration even if no Station manifest exists.
