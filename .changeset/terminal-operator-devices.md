---
'@kontourai/station-contracts': minor
'@kontourai/station-sdk': minor
---

Terminals for every operator device (#3994). The SDK adds
`TerminalSessionStore`, which operates every terminal on one Station over the
same-origin `/api/terminal/socket`: open (by server-resolved launch profile) or
attach, coalesced input, latest-wins resize, a bounded output buffer, and
per-session resume with backoff. Its `TerminalSession` interface is what a
renderer consumes. Sockets are admitted before the upgrade by a single-use
ticket from `POST /api/terminal/tickets`, minted through the ordinary
authenticated transport, including a native shell's host transport.

`TerminalOutputSession` now uses the same ticket: it no longer sends a
credential frame and accepts a native host transport. It needs a host with the
ticket route; an older host reports `unsupported-host`. Its `createSocket`
callback receives the offered subprotocols as a second argument.

The contracts add the ticket path, lifetime and subprotocol constants,
`TerminalTicket`, `TerminalLaunchProfile` and `TERMINAL_CLOSE` to
`terminal-transport`, and optional `projectId`/`bindingKey` on an engine sign-in
attempt's `terminal`, naming the socket scope to attach under.
