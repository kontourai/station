# ADR 0018 — SSE is the realtime transport, because resume rides `Last-Event-ID`

**Status:** Accepted. Records a choice that was already load-bearing but
undocumented; no behaviour changes with this ADR. Filed as station#935.

## Context

Station streams agent and chat output to its clients over Server-Sent Events.
Nothing recorded why. The only transport decision previously written down is a
narrower one — use authenticated `fetch`-SSE rather than `EventSource`, because
`EventSource` cannot send an `Authorization` header — which is enforced as a
test (`src-ui/src/__tests__/authenticated-stream-inventory.test.ts`) but decides
a question *within* SSE, not SSE versus WebSockets.

Meanwhile a substantial amount of machinery has become bound to the SSE choice:

- A durable event log with a global monotonic sequence
  (`src-server/services/.../event-store.ts`), whose own docblock describes it as
  "the resume cursor for the `/api/orchestration/events` SSE stream".
- Every live frame carries that sequence as the SSE `id:` field
  (`src-server/routes/orchestration/orchestration.ts`), and a reconnecting
  client returns it as `Last-Event-ID`.
- Bounded replay-or-snapshot resume (`resolveStreamResumePlan`), authorization-
  filtered per replayed event, behind a subscribe-then-buffer ordering fence so
  a live event cannot overtake replayed history.
- A negotiated capability (`eventStreamResume`) advertised on the public
  handshake descriptor and probed by the client, fail-closed.

An undocumented decision that this much depends on is one revisit away from
being casually reversed.

## Decision

SSE remains Station's realtime transport for orchestration, chat, monitoring,
and scheduler event streams. The deciding property is **resumability**:
`Last-Event-ID` is a primitive the browser gives SSE for free, and Station's
resume design is built directly on it.

WebSockets are not rejected for lack of plumbing. Station already runs
authenticated WebSockets in production for the terminal (`port + 1`) and voice
(`port + 2`) surfaces, sharing a first-application-frame auth protocol,
rate limiter, and capacity gate. A WebSocket chat transport would reuse that,
not invent it. What it would have to reinvent is cursor negotiation — an
application-level handshake replacing a browser-provided one — and with it the
replay/snapshot correctness properties above.

## Consequences

**Connection budget is bounded and monitored by hand, not by a mechanism.**
Station serves over HTTP/1.1 on loopback (`@hono/node-server`; no HTTP/2 or TLS
configuration exists), so clients are subject to the browser's ~6-connections-
per-origin cap. Current usage sits well inside it: two always-on streams
(`/events` and `/api/orchestration/events`), plus at most three view-scoped
streams (a thread-scoped stream in the Activity view, `/scheduler/events`, and
`/monitoring/events`) that are rare in combination. Chat output is multiplexed —
`ensureOrchestrationEventStream` dedupes by `apiBase`, so N open chats still use
one connection. The terminal and voice WebSockets live on other origins and
consume none of this budget.

This budget is a real constraint with no enforcement. Adding a sixth always-on
per-client stream to the main origin would be the point at which this decision
needs revisiting — that, and not host load or throughput, is the forcing
function to watch.

**Host resource pressure is not a reason to revisit this.** Station's admission
controls act on starting engine processes, never on connections; no SSE route
consults them, an open stream is never torn down by them, and resume is a pure
event-store read. The same would be true under WebSockets, so nothing in that
area distinguishes the two transports.

**Proxy deployments need explicit configuration.** SSE responses must not be
buffered by an intermediary. See station#933 and the SSE guidance in
`docs/guides/deployment.md`.

## Alternatives considered

**WebSockets for the chat/orchestration stream.** Rejected: it buys
bidirectionality Station does not need on this path — the interactive send is an
ordinary `POST /api/orchestration/chat` returning a JSON ack (ADR 0014), not a
socket write — and costs the resume machinery described above.

**HTTP/2 to relax the connection cap.** Not pursued, because the cap is not
currently binding. Worth reconsidering only alongside the sixth-stream trigger
above; it would also change the loopback and proxy story, so it is a larger
decision than a transport tweak.
