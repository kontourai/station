# Station API Summary

This file no longer carries a hand-maintained endpoint count or route table.
Those summaries drifted independently from the server and could make a retired
or protected route look current.

Use the [HTTP endpoint authority](endpoints.md) to choose the right source:

- [OpenAPI](openapi.json) is the checked-in machine-readable subset. Its bytes
  are compared with `buildOpenApiSpec()` by the documentation foundation tests.
- `src-server/routes/` owns implementation truth for route families not yet in
  OpenAPI.
- [API documentation](api.md) is historical narrative and worked examples, not
  a complete inventory.
- [CLI reference](cli.md) is the preferred user-facing interface when a CLI
  command exists.

Protected routes require an authenticated Station credential. Loopback access
does not bypass authentication, and an old route example is not evidence that
a deployed Station still exposes that route.
