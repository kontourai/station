---
"@kontourai/station-sdk": minor
---

Add a React-free TerminalOutputSession for authenticated observation of an existing terminal through the Station API listener. Replay credit follows applied output; retention resets await the renderer, and bounded reconnect resumes the same terminal from its applied cursor. Older hosts return an explicit unsupported result. Broker and credential-less native transports are refused.

This client sends no shell input or terminal lifecycle commands. It does not replace the Coding view or qualify remote pairing, native transport, Ghostty or installed-device reconnection.
