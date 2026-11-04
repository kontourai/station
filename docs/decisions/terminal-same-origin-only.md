---
status: current
subject: Terminals use only the same-origin socket; the port + 1 listener is removed
decided: 2026-11-01
evidence:
  - kind: adr
    ref: docs/adr/0018-sse-is-the-realtime-transport-because-resume-rides-last-event-id.md
  - kind: doc
    ref: docs/design/terminal.md
  - kind: issue
    ref: https://github.com/kontourai/station/issues/3994
---

# Terminals use only the same-origin socket

## Decision

Every terminal reaches Station through `/api/terminal/socket` on the API
listener, admitted by a single-use ticket from `POST /api/terminal/tickets`.
The dedicated terminal WebSocket listener on the server port + 1, its
`GET /api/system/terminal-port` route, the SDK's `fetchTerminalPort` and the
`TerminalService` behind them are removed. Station no longer binds, reserves or
probes the server port + 1, and the core no longer offers a `terminal`
listener to the process supervisor.

This supersedes the terminal half of
[ADR 0018](../adr/0018-sse-is-the-realtime-transport-because-resume-rides-last-event-id.md)'s
statement that Station runs authenticated WebSockets for the terminal on
`port + 1`. The voice WebSocket on `port + 2` is unchanged, and SSE remains the
realtime transport for event streams.

## Why

Proxies, tailnet names and the relay forward only the main origin, so the
second listener failed on phones and behind any single-origin ingress. Since
the same-origin socket serves every operator device, nothing reached the
legacy listener.

## Compatibility

A supervisor started by an older Station can still hold a `terminal` listener
and offer it at promotion. The core closes its copy of that handle and any
connection the supervisor hands over for it; the supervisor keeps the port
until it restarts. The port block keeps its width, so voice stays at
`port + 2` and consent at `port + 3`.
