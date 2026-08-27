# Task Dispatcher

`TaskDispatcher` is the dispatch Module. Its Interface is one operation:
`dispatch(taskId, intent)`, returning a total `DispatchOutcome`. A missing
task is explicitly `not-found`; contention and terminal lifecycle states are
separate outcomes. Callers learn
neither graph reservation phases, assignment-claim cleanup, provider selection,
nor telemetry ordering.

Runtime composition places the Seam in `composeTaskDispatcher`. `TaskGraphService`
provides four private-to-dispatch Adapters: durable graph transitions, assignment
claims, remote sessions, and telemetry. The dispatcher Implementation owns the
transaction and compensation ordering; the graph Implementation owns durable
facts. This gives callers Leverage while keeping change and verification local.

Cancellation is part of the Interface. The claim Adapter receives the same
signal and must observe it before external work. If an abort or deadline wins
after claim admission began, even a late successful claim is ownership-unknown,
so the outcome is `indeterminate` and reconciliation—not a blind retry—is
required. Before any external claim has begun, abort returns retryable
`aborted` only after the reservation is durably restored. Once a provider start
request has crossed its Adapter, cancellation or timeout is likewise
`indeterminate`: the remote Implementation may have created a session.

Every confirmed release of a prior assignment claim is persisted immediately.
It is never deferred to a later association write, because that write might not
happen. A failed release or reservation restoration is likewise `indeterminate`,
never presented as retryable success.
