# Builder Delivery Viewer

An opt-in, read-only Station layout for Builder Kit artifacts in a project's
`.kontourai/flow-agents/` directory. It reads only published `state.json`,
`acceptance.json`, `trust.bundle`, and delivery companion filenames.

The server validates state and acceptance with the JSON Schemas packaged by
`@kontourai/flow-agents`, validates trust through its public root export, and
passes the derived `@kontourai/surface` report to Surface's public custom
element. It opens only regular files through bounded descriptors, caps each
request, rejects symlinked artifacts, and imports no mutation-oriented
filesystem or lifecycle API. The browser proof fixture compares complete
Builder/delivery tree manifests before and after viewing; that fixture's
existence is not a new live result for this checkout.

Station does not yet mediate raw server-module filesystem access through an
enforceable host capability; [Station #501](https://github.com/kontourai/station/issues/501)
owns that platform boundary. This plugin's read-only claim therefore describes
the reviewed implementation and its gates, not a process sandbox.

Install it from Station's example registry, add its project layout, and select
**Builder sessions**. Flow runs are joined only where Builder state contains an
explicit, exact `flow_run.run_id` match.

The browser artifact reader uses raw fetch and query keys based on Project and
session, without the selected Station in those keys. Remote/native credentials
and switching between Stations with matching IDs need separate caller
qualification; the current guide does not establish those journeys. See the
[implementation](src/index.tsx) and [server tests](server/__tests__/plugin-server.test.ts).
