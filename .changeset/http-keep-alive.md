---
"@kontourai/station-shared": patch
---

Add `configureHttpKeepAlive` to `@kontourai/station-shared/http-upload`. The API listener and the CLI's serialized UI listener now hold an idle connection for 65 seconds instead of Node's default 5, so a client that polls reuses its connection instead of opening a new one, and a reverse proxy with a 60-second idle limit closes its upstream connection before Node does.
