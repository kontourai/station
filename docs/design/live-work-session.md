# Live-work session contract

`LiveWorkSession` is #2914's deep, pure Station module for one exact Project,
Task, surface, session, and configured channel identity. It owns no API, route,
database, UI, transport, message log, or revision store. #2972 composes its
narrow material-history Adapter; ephemeral presence remains in memory.

## Authority and live projection

Callers provide request intent: actor ID, request ID, and the requested action.
An injected server identity/work authority supplies actor kind and label, the
independent occurrence ID, exact session and optional run, current named work
state, work name, start time, and a server-issued TTL closure request ID. A
caller cannot assert or replace those facts. Join is private by default; only a
confirmed material announcement becomes visible and targetable.

Explicit depart removes the participant and pauses follow/watch edges before a
durable Adapter result. Withdraw immediately makes the participant private and
pauses those edges. TTL also removes liveness immediately. An indeterminate
durable closure is retained independently and remains recoverable; replay never
reconstructs presence. Typing and pane state are separately bounded and expire.

## Exact material lifecycle

Every durable intent freezes `occurredAt`, server/caller-issued request and
occurrence identity, a monotonic ordinal, exact scope, server actor/work facts,
and optional immutable revision ID. Its fixed-size ID is SHA-256 over an
explicit length-prefixed ordered scalar sequence, never object insertion order
or delimiter concatenation. Retries reuse the exact cloned intent.

One announcement owns exactly one reserved closure. A closure is a
`presence-ended` material fact with an explicit `departed`, `withdrawn`, or
`expired` reason; it is never a work-completion claim. Deliberate
`work-finished` materialization separately requires `completed`, `failed`, or
`cancelled` and can retain exact run/revision links. Count and exact worst-case
UTF-8/serialized request-ID byte capacity for both are admitted before the
announcement Adapter call, so revision work cannot consume mandatory departure
capacity. Repeated depart/withdraw,
TTL, export, and restart all reuse the same closure intent. A closure waits for
an ambiguous announcement: committed announcement settles that one closure;
refused announcement terminalizes it without emitting an orphan departure.
Only `indeterminate` remains pending. `committed` and `refused` are terminal
once, and malformed/throwing Adapter output becomes indeterminate.

Replay capacity is a configuration invariant: it is at least the participant
ceiling, so every open published announcement remains representable alongside
its mandatory pending closure. Admission reserves that capacity for every
unresolved lifecycle, including a departed participant whose closure is still
indeterminate. Recovery accepts at most one pending departure closure for each
lifecycle, selected by that lifecycle's exact closure ID.

## Time, revision, and recovery

Every public entry validates finite safe monotonic time, exact closed input,
scope, actor, capability, and rate budget before prune, mutation, authority
calls, or Adapter effects. Actor reconciliation shares the transition budget.
Export, restore, and system reconciliation use a separate server-owned recovery
authority and bounded recovery budget, so revoked actor authorization cannot
strand a possible durable effect and cannot be used to mint recovery authority.

Recovery state is a closed, bounded, defensively cloned record of pending
intents and dependencies, ordinals, terminal tombstones, closure reservations,
safe clock, and confirmed material replay. Terminal closure records retain their
exact announcement dependency, actor, and occurrence identity. Replay is a
self-contained bounded suffix: rolled-off terminal facts remain available for
idempotency only while retained, and complete announcement/departure lifecycle
blocks roll off together so a retained departure never lacks its retained
announcement. Replay order is strictly increasing by durable ordinal; a suffix
may begin after an earlier ordinal but never reorders it.
Participants, panes, and typing are not restored. Missing required Adapters
refuse restoration rather than create an unrecoverable obligation.

Revision references enter only through an injected #2891 resolver. `AVAILABLE`
must be a closed result for the exact requested revision ID, Project, Task,
session, and applicable run. Caller-provided verification text alone grants
nothing. Private work cannot reference a revision. The room adapter resolves
revision intent through the room's outcome-link path, never a caller
"verified" field.

## Durable room composition

`ProjectTaskLiveWorkHistoryAdapter` consumes the room authority and an injected
server grant issuer only. It freezes the live intent before awaiting, uses its
stable `intentId` as the room `proposalId`, and derives canonical ISO time,
scope correlation, causation, and body from server-resolved live facts. It
selects `agent-publish` for server-resolved agent facts (and the narrower
lifecycle/revision grant only for an operator), so callers cannot choose the
room principal. It settles async commits totally: committed and duplicate
outcomes retain a fully validated, deep-frozen immutable room receipt; named denials/refusals remain refused; malformed,
unavailable, and throwing authority paths are indeterminate. Exported recovery
state carries those stable IDs, so a restart retries the same proposal and the
room duplicate receipt prevents a second history record. Close advances a
generation fence before awaiting room close; an in-flight result cannot update
the closed live projection, and the first close promise/outcome is memoized for
every later caller.

All identifiers, labels, maps, pending count/bytes, tombstones, replay, typing,
panes, time arrays, rates, and TTLs have absolute ceilings. Accepted strings
are well-formed Unicode: unpaired UTF-16 surrogates fail before hashing or byte
accounting. Inputs, Adapter calls, snapshots, replay, exports, and restored
state are defensively cloned.
