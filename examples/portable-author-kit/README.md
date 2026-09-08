# Portable Author Kit

This example contains an Agent Plugins 1.0 Skill and one Agent declared in the
`io.kontourai.station` namespace. Other clients can consume the Skill without
understanding the Station Agent. No npm dependencies or custom build command are
required by this package.

## Try it from a Station source checkout

Use the repository's required Node version. From the repository root, install
workspace dependencies with `npm run dependencies:ci`, then build the public CLI
with `npm run build:cli`. A released CLI must include the Agent Plugins authoring
support described in [the contract](../../docs/reference/agent-plugins.md); older
published versions may not include these changes.

```sh
cd examples/portable-author-kit
node ../../packages/cli/dist/station.mjs plugin build
node ../../packages/cli/dist/station.mjs plugin install .
```

The build validates the manifest and needs no bundle for this data-only package.
Installation requires a running, authenticated local Station. Review its preview
and permission request. The CLI forwards the reviewed content and grant revisions
to the same installation API used by the UI. A local path works only when the CLI
and selected host have the supported local filesystem relationship; use a Git
source for a remote host.

After installation is ready, `portable-author-note` appears in Agents. Configure
a model connection in Station before starting a conversation with it. The Skill
is available through the ordinary installed Skill catalog; installation does not
automatically attach every Skill or MCP server to every Agent.

## Adapt it for another company

Choose unique package and Agent IDs, edit the prompt and Skill, and increment the
package version. Keep portable fields at the manifest root and Station fields in
its namespace. Source and publisher trust come from the host acquisition owner,
not from a name inside this package. See the [CLI reference](../../docs/reference/cli.md) for host selection and
authentication.

Normal managed updates retain the independent data scope. Removal withdraws
contributions and retains old code/data while effects may remain. Interrupted
activation needs a fresh recovery preview and decision; see the
[lifecycle contract](../../docs/design/plugin-installation-lifecycle.md).

This is a public local-author example. It does not establish hosted tenant
isolation, data migration, Marketplace entitlement, or an enterprise adapter.
