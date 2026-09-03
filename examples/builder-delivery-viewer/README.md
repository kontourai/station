# Builder Delivery Viewer

An opt-in, read-only Station Workspace Pane set for Builder Kit artifacts in a project's
`.kontourai/flow-agents/` directory. It reads only published `state.json`,
`acceptance.json`, `trust.bundle`, and delivery companion filenames.

The server validates state and acceptance with the JSON Schemas packaged by
`@kontourai/flow-agents`, validates trust through its public root export, and
passes the derived `@kontourai/surface` report to Surface's public custom
element. It opens only regular files through bounded descriptors, caps each
request, rejects symlinked artifacts, and imports no mutation-oriented
filesystem or lifecycle API. The live proof compares complete Builder/delivery
tree manifests before and after viewing.

Station does not yet mediate raw server-module filesystem access through an
enforceable host capability; [Station #501](https://github.com/kontourai/station/issues/501)
owns that platform boundary. This plugin's read-only claim therefore describes
the reviewed implementation and its gates, not a process sandbox.

Install it from Station's example registry, enable its panes for a Project, and select
**Builder sessions**. Flow runs are joined only where Builder state contains an
explicit, exact `flow_run.run_id` match.
