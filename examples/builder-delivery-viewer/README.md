# Builder Delivery Viewer

An opt-in, read-only Station layout for Builder Kit session artifacts under a
project workspace's `.kontourai/flow-agents/` directory: `state.json`,
`acceptance.json`, and `trust.bundle`. It also lists known companion filenames
under `<workspace>/delivery/<task-slug>/`.

The server validates state and acceptance with the JSON Schemas packaged by
`@kontourai/flow-agents`, validates trust through its public root export, and
passes the derived `@kontourai/surface` report to Surface's public custom
element. Its artifact reader opens only regular files through bounded descriptors,
limits each artifact to 1 MiB and artifact bytes per request to 16 MiB, rejects
symlinked artifact files, and imports no mutation-oriented
filesystem or lifecycle API. The browser proof fixture compares complete
Builder/delivery tree manifests before and after viewing; that fixture's
existence is not a new live result for this checkout.

Station does not yet mediate raw server-module filesystem access through an
enforceable host capability; [Station #36](https://github.com/kontourai/station/issues/36), folded into [#162](https://github.com/kontourai/station/issues/162),
owns that platform boundary. This plugin's read-only claim therefore describes
the reviewed implementation and its gates, not a process sandbox.

Install it from Station's example registry, approve the separate host-owned
`plugin.server` permission, add its project layout, and select **Builder sessions**.
The server examines at most 1,000 directory entries and includes at most 100
session directories; that subset is then sorted by published update time.
Delivery companions are reported by filename, not cryptographically verified
as a seal by this viewer. Flow runs are joined only where Builder state contains an
explicit, exact `flow_run.run_id` match.

The browser artifact reader uses raw fetch and query keys based on Project and
session, without the selected Station in those keys. Remote/native credentials
and switching between Stations with matching IDs need separate caller
qualification; the current guide does not establish those journeys. See the
[implementation](src/index.tsx) and [server tests](server/__tests__/plugin-server.test.ts).
