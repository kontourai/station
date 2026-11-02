---
'@kontourai/station-sdk': minor
'@kontourai/station-cli': patch
---

The legacy terminal listener on the server port + 1 is gone (#3994). The SDK
no longer exports `fetchTerminalPort`, and `GET /api/system/terminal-port` is
no longer served; terminals use `TerminalSessionStore` over the same-origin
`/api/terminal/socket`. The CLI no longer reserves or waits on the server
port + 1 when it starts an instance.
