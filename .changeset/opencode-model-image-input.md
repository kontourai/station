---
'@kontourai/station-contracts': minor
---

`ModelOptionCapabilities` gains an optional `imageInput`: whether the engine
reports that a model accepts image input. Absent means the runtime did not
say. Station fills it for OpenCode models from OpenCode's own model listing, so
the chat composer can refuse an image for a model that cannot read one, and
stop warning for a model that can.
