---
'@kontourai/station-cli': patch
---

`station schedule create` accepts a body with a `displayName` and no `name`;
the host then picks an unused slug and prints it as `name`. A body with
neither, or with no `prompt`, is still refused before any request.
