---
status: current
subject: Keep Room durability independent of realtime transport and harden SSE first
decided: 2026-10-22
evidence:
  - kind: doc
    ref: src-server/services/projects/project-room-store.ts
  - kind: doc
    ref: src-server/routes/projects/project-room-routes.ts
  - kind: doc
    ref: packages/sdk/src/query-domains/projectRooms.ts
  - kind: doc
    ref: src-server/security/websocket-auth.ts
---

# Project Room realtime delivery

## Decision

Room identity, message order, duplicate-send receipts, notes, Agent publication
and access remain application contracts independent of SSE or WebSockets.
HTTP mutations and SSE deliver the current Project Room experience. Replace
periodic content polling with notifications after committed changes, coalesce
bursts, bound slow-reader buffers, and preserve reconnect reconciliation and
current authorization checks. A transport switch must not change durable
history or grant access.

For a future many-channel chat experience with frequent typing, presence and
subscription changes, an authenticated multiplexed WebSocket is the preferred
candidate. Shared multiplexed SSE remains an alternative for mostly passive
subscriptions. This is a provisional architectural preference, not a measured
performance result. A WebSocket implementation is not required for the current
single mounted Project Room.

## Boundaries

The current UI shares one mounted Room between Overview and the expanded Room.
It must not grow into one persistent connection for every backlog Task. Neither
SSE nor WebSockets supplies durable replay, duplicate prevention or permission
revocation automatically. Reconnecting clients reconcile with the Room's
ordered persisted history; ephemeral presence is not restored as live after a
restart. Each transport must independently qualify snapshot/live handoff,
backpressure, bounded buffering, cancellation and protected delivery.

Station already depends on `ws` and has authenticated terminal WebSocket
infrastructure. Those permissions cannot be reused for Rooms: account/member
Room admission and per-channel authority must remain explicit. Native HTTP
streaming and the CLI UI proxy support SSE today. A future Room WebSocket also
needs authenticated native bridging and upgrade routing through supported
proxy and SSH paths.

## Selection evidence

Do not choose a transport from direct-local socket throughput alone. Compare
shared SSE and WebSocket delivery with identical event production and access
rules at 1, 10 and 100 subscribed channels, multiple tabs, idle periods,
frequent typing, and bursts. Measure requests, bytes, CPU/RSS, queue bounds and
commit-to-render latency. Qualify reconnect gaps, restart, stalled readers,
account/profile switches and revocation with queued frames. Native and SSH
paths require their own evidence; mobile background/battery behavior requires
real-device observation.

The SSE hardening and its focused evidence belong to the onboarding Project
experience branch. The future multiplexed transport comparison does not imply
that custom channels, cross-Station sharing, voice or collaborative document
editing have shipped.
