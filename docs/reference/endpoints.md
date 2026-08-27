# HTTP endpoint authority

This repository does not maintain a hand-written endpoint inventory. Route
paths, schemas, and availability change with the server; a static table can
accidentally prescribe unauthenticated or retired behaviour.

Use these authorities instead:

- The checked-in, first-pass [OpenAPI document](openapi.json). It is a static
  repository artifact, not a runtime route or a claim that every deployed
  Station exposes OpenAPI.
- The route modules in `src-server/routes/` for implementation truth.
- `src-server/security/` and [configuration](config.md) for pairing,
  credential, locality, and authorization boundaries.
- `station target` / [CLI reference](cli.md) for selected-Station identity and
  client targeting.

Do not infer that a route is unauthenticated, that an agent named `default`
exists, or that a path remains supported from an old endpoint list. Resolve a
specific Station and use its authenticated route/auth surface; compare any
request with the static OpenAPI artifact only as a reviewed starting point.
