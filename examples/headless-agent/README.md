# Headless Agent application

This application submits work and reads one status/event page through
`@kontourai/station-sdk/agent`. It has no Pane, React import, plug-in manifest,
or local engine loop. It can target the same Agent that a plug-in distributes.

## Build from a source checkout

Use the repository's required Node version and run `npm run dependencies:ci`
from the root. Then:

```sh
cd examples/headless-agent
npm run build
```

The workspace supplies the SDK and esbuild. For an independent project, use a
published SDK version whose export map includes `/agent`, and a
TypeScript-aware bundler or runner. This example does not install dependencies
or start Station. The SDK package retains its existing peer dependency metadata.

## Run against your Station

Select an authenticated Station, an available Agent, and an accessible Project.
Supply an authorized bearer credential as `STATION_AGENT_TOKEN` through your
normal secret mechanism. Do not commit it or paste it into a manifest.

```sh
npm run start -- https://station.example.com review-specialist example-project 'Review the current diff.'
```

This executes provider work. It prints the accepted handle and one current
snapshot/event page; it does not wait for completion or automatically accept
requests. Keep the printed conversation, Session, Environment identity, and
cursor for the guide's observation, continuation, and interruption operations.
A timeout or read failure after create can mean work is already running: do not
rerun this command blindly. A received handle is not verified task completion.

To exercise plug-in distribution, install the existing
[Portable Author Kit](../portable-author-kit/README.md), configure its engine,
and pass `portable-author-note` as the Agent ID. The headless application calls
the Agent by its clean catalog identity; a plug-in name is not an execution grant.

## Evidence

The example is included in `npm run typecheck:examples`; `npm run build` bundles
its real public imports for Node. A live run requires your Station, Project,
engine, and credential. Build and boundary checks do not prove a provider ran or
that authorization was granted. The script deliberately propagates failures.

Read [Agent development](../../docs/guides/agent-development.md),
[the SDK reference](../../docs/reference/sdk.md#agent-development-entry), and
[ADR 0021](../../docs/adr/0021-separate-plugin-and-agent-sdk-surfaces.md).
