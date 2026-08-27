# Collaborative editor pane

Issue #2890 is the Workspace Pane projection for shared text/code work. It is
not the durable Project Chat discussion surface and it is not a new event or
message store.

## Module shape and authority

The module composes replaceable, intent-shaped Adapters:

- `CollaborativeAuthorityAdapter` resolves the server-owned local actor and
  exact Project/Task/document grant at every ingress. It does not cache a UI
  permission guess.
- `SharedWorkingStateProjectionAdapter` returns typed #2889 outcomes for only
  accepted operations and exact resync results. The provided direct Station
  Adapter composes #2889 live/recovery ports; the pane never merges text.
- `SharedWorkingStateEditingCapability` owns the server-side #2889 snapshot,
  write grant, and atom identity needed to translate textarea edits into exact
  frozen operation batches. It applies those same batches to a cloned
  `SharedWorkingState` for preview; the pane never receives atom snapshots or
  transform payloads.
- `CollaborativeEditorTransportAdapter` submits one frozen, digest-identified
  batch as one idempotent intent. It returns total `accepted`,
  `definitely-not-invoked`, `refused`, or `indeterminate` truth; per-operation
  settlement remains projection-owned. It cannot retain a durable editor log.
- `CollaborativeRevisionResolverAdapter` resolves a #2891-compatible immutable
  evidence revision only when evidence ID, scope, correlation, returned
  working-state revision, and projection all match.
- Host navigation, cursor output, and live-room context remain separate
  Adapters. Coding placement/catalog/renderer selection is not owned here.

The `CollaborativeLiveRoomContextAdapter` supplies bounded ephemeral room
state only while current document-read plus room-join/read authority exists.
Its closed projection carries exact scope, server-owned monotonic stream
generation plus authority-bound epoch, sequence, connection,
TTL-bound participants/cursors with working-state revision, and departures—not
messages, history, or a database. One new-epoch snapshot may reset sequence;
old-generation deltas remain ignored without a retired-epoch cache. Delta
application is transactional over the resulting 64-participant/cursor caps,
and a quiet clock pump removes expired state without waiting for another room
packet.
The later room authority owns durable discussion and maps its public projection
at this seam.

## Product semantics

The pane distinguishes document read/write from room join/read/share/watch/
follow. Solo read/write remains usable without joining a room. A read-only
person retains authorized document truth but cannot form a new operation.
Possible-effect batches remain in a private intent/operation ledger with
count/byte bounds and exact per-operation settlement until #2889 proves each
operation non-deferred or releases its ID. Duplicate-but-still-deferred
operations retain projection; released IDs use the protocol bound rather than
the old local 32-entry assumption. Public state exposes only non-content intent
ID, counts, aggregate states, timestamp, and bounded reason. ID/effect digest
authority stays in #2889, where display/correlation metadata is excluded.
One planned batch is one external effect: all causally ordered delete chunks
and a replacement insert cross the transport seam together, with a stable
server-owned canonical SHA-256 digest. Planning is `uninvoked`; only the final
instruction immediately before `submitBatch` changes it to `possible-effect`.
A lifecycle or authority fence before that boundary is definitely-not-invoked,
removes the optimistic intent, and records a safe refusal. Response loss retains
one possible-effect batch and retry reuses the identical frozen batch.

Batch/member settlement is fail-closed: `accepted` may coexist with
`possible-effect`, `committed-awaiting-projection`, or `projected`, and
`indeterminate` may coexist with those states while recovery is pending.
`refused`/`definitely-not-invoked` may settle only uninvoked or otherwise
unprojected members. A projected member followed by either outcome, or an
accepted batch followed by a member refusal, is a contradiction: the batch is
retained with indeterminate possible-effect evidence and the pane becomes
stale. It is never shown as an ordinary rejection or healthy delete-only
replacement state.
Even when every member has already projected, the bounded private batch record
survives until its one total transport response arrives. A late accepted result
then finalizes consistently; late refusal/not-invoked is quarantined as an
integrity contradiction, and indeterminate retains its evidence without a
duplicate transport call.

Watch state is `off`, `active(target, followableView)`, or `paused(reason)`.
Follow drives one target-authority helper as a target moves; every jump/follow
first resolves the exact target document/revision bounds and mints an opaque
one-use capability bound to the authority revision, actor, Project/Task,
document/view, expiry, and nonce. The host validates and consumes that
capability inside one `joinAndNavigate` effect; the controller never navigates
and then rechecks. Reconnect,
replacement omission, rejoin, departure, target switch, and navigation failure
are explicit. Local pointer, navigation, selection, or edit exits follow while
leaving ordinary watch intact; explicit Stop watching returns to `off`. A
followable view may cross documents only inside the exact Project/Task. No path
enters that intent. Revocation, expiry, or token mismatch during the host effect
produces no navigation or active watch state.

Presence never includes a local path. A participant can only be in this exact
shared Project/Task, an authorized but unshared surface, or outside/undisclosed.
Human/agent kind and actor ID come from a server-owned principal
authority at exact scope/working revision, never `operation.actor.kind` or room
labels. Kind equivocation rejects the whole update; session/run may change with
presence, while each accepted edit freezes its own bounded correlations.
Read/room revocation masks every remote identity and resets watch to `off`.
Remote selections are rendered in one synchronized textarea-layout `<pre>`
document copy with all exact `<mark>` ranges. The editing capability transforms
authorized ranges through private pending atom operations into `displayText`
coordinates; stale ranges are suppressed. Coincident carets merge stable actor
IDs, and the screen-reader surface reports only a bounded count.

Every runtime collection and string has a hard examined-entry, count, UTF-8,
text, TTL, or cursor/document bound. Duplicate or invalid arrays fail closed;
oversized arrays and huge strings are rejected from code-unit/length floors
before member examination or UTF-8 allocation. The controller admits at most
20 outbound cursor updates per rolling second even if an Adapter claims more.
Restore/resync need exact document-read authority but no room grant; they share
an abort generation so older responses cannot overwrite newer truth. Dispose
fences every asynchronous callback, cancels TTL/recovery work, prevents
reentrant subscription, and closes its room Adapter exactly once.
Planner chunks delete targets by measured serialized operation bytes and shares
operation, batch-byte, and batch-operation ceilings with the pane, allowing the
declared maximum text fixture and ordinary 129+ atom selections before refusing
only an actual pre-effect bound violation. Injected actor/attribution objects are cloned
and validated without being frozen by the module. Missing current room-stream
authority masks room state as stale; old authenticated packets remain inert.

## Scope

This slice exposes the server-owned editing capability, pure controller, and a
focused accessible React surface.
Workspace Pane catalog/host composition, authenticated browser transport,
durable snapshots, and reference performance proof remain integration work.
