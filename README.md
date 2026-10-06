# Station

**An agent workspace for projects, execution, and evidence.**

Station is Kontour's open-source, local-first workspace for agent work. Bring
your agents, projects, and devices together, hand a Task to the agent you
choose, and keep execution history, files, review evidence, and receipts beside
the work. A completed run and a passed review are separate facts.

[Product site](https://station.kontourai.io) ·
[Documentation](https://kontourai.github.io/station/docs/) ·
[Getting started](docs/user/getting-started.md) ·
[Concepts](docs/user/concepts.md) ·
[Contributing](CONTRIBUTING.md)

> **Status:** open source under active development (Apache-2.0). Run Station
> from source on macOS or Linux, or try a Nightly desktop build.
> The portable installer requires a published release in the selected ring. See
> [Get Station](#get-station).

## Why Station

Station brings several parts of agent work into one workspace:

- **Evidence beside the work** — inspect gate results, missing evidence,
  review receipts, and exceptions where the configured workflow provides them.
  Creating or completing a Task does not by itself prove a gate passed.
- **Supported engines, one workspace** — run Station agents on a local or
  hosted model, or connect supported agent CLIs and compatible custom engines
  as External agents. Each engine keeps its own behavior and tool loop;
  Station supplies project context, execution records, and configured workflow
  integrations.
- **Work that outlives a chat** — Projects, Tasks, Sessions, changed files,
  artifacts, and receipts stay linked. Reopen a Task later with its recorded
  workspace binding and evidence, then check the workspace's current availability.
- **Your devices, your Station** — pair a phone, tablet, or laptop to your
  Station with scoped, revocable access, and delegate work to another
  computer you own over SSH.
- **Local-first ownership** — Station data lives under `~/.station` by
  default. Networked features have separate settings and destinations;
  review those boundaries under [Data and privacy](#data-and-privacy).
- **Built to extend** — plugins add layouts, agents, tools, knowledge,
  connections, skills, and work surfaces through the public SDK and extension
  contracts. Private core services are not part of that plugin API.

## What people use it for

| You want to… | In Station |
| --- | --- |
| Ship a code change you can stand behind | Open the repository as a Project, create a Task, pick an agent, and keep the commands that ran, their results, and the review receipts with the change. |
| Keep a long piece of work alive | A Task spans as many Sessions as it needs. Follow it from a paired device and come back to the same context, files, and evidence. |
| Use agents without a cloud account | A configured local model can provide inference without a cloud account. Tools, engines, and other enabled integrations retain their own network behavior. |
| Coordinate several agents | Delegate bounded work from one agent to another, or run it on a remote computer over SSH with that machine's own agents, credentials, and workspace. |
| Run Station on a server you control | Review the deployment recipe, image provenance, home ownership, and authenticated ingress. |
| Build a purpose-built work surface | Write a plugin using the public SDK: a review workbench, a release console, or a domain-specific layout. |

## Get Station

### Run from source (macOS, Linux)

Requires Node.js 24.x, npm 10 or newer, and git. On Linux, interactive
terminal panes additionally need a C++ toolchain (`g++`, `make`, `python3`);
without one Station still runs and reports that capability as degraded.

```bash
git clone https://github.com/kontourai/station.git
cd station
npm run dependencies:ci
./station start
```

Open the UI address the command prints, then follow
[First steps](#first-steps). The [developer guide](docs/guides/development.md)
covers instances, ports, temporary homes, and the desktop app build.

### Nightly desktop build

The [Nightly desktop pre-release](https://github.com/kontourai/station/releases/tag/nightly-desktop)
carries macOS Apple silicon and Windows x64 builds for testers. Choose an asset
for your platform and check its version; retained assets can belong to earlier
builds. Nightly has its own install and update channel. See the
[Nightly guide](docs/guides/nightly.md) for supported paths and limitations.

### Verified installer (when a stable release is published)

Stable and beta portable releases use signed GitHub release rings. Check the
[release list](https://github.com/kontourai/station/releases) and
[release-ring guide](docs/guides/release-rings.md) for current availability;
desktop updater channel tags are not portable release rings. For an available
ring, the bootstrap below verifies the release's
GitHub OIDC attestation and SHA-256 receipt before installing under
`~/.station/installs/stable`, linking `station` into `~/.local/bin`, and
opening the UI at `http://localhost:18000`. It requires Node.js 24.x, npm 10
or newer, curl, tar, and [GitHub CLI](https://cli.github.com/) with attestation
verification support. The command below supplies a token from your authenticated
GitHub CLI session to the installer's isolated verification environment.

```bash
sh -c 'set -eu; file=$(mktemp "${TMPDIR:-/tmp}/station-install.XXXXXX"); trap '\''rm -f "$file"'\'' EXIT HUP INT TERM; curl -fsSL https://raw.githubusercontent.com/kontourai/station/main/install.sh >"$file"; chmod 600 "$file"; GH_TOKEN=$(gh auth token) sh "$file"'
```

Run the command again to install the selected release. The installer stages it
before switching the current link.
Set `STATION_CHANNEL=beta`
for the beta ring, which uses `station-beta` and `http://localhost:28000`.
[Getting started](docs/user/getting-started.md) covers channels, updates, and
uninstall.

The separate [signed prebuilt-archive path](docs/guides/release-channel-ports.md#prebuilt-archives-and-source-releases)
uses an explicit public manifest URL and bundled Node.js on macOS/Linux,
without a host build. It may download a pinned Node.js for initial verification;
installer support does not establish availability of a published manifest.

### Self-host with Docker

The Dockerfile's foreground `service run` supervisor atomically claims a fresh
home without requiring `service install`. While another live owner holds the
home, it waits without running Station and starts after that owner is gone.
See the [deployment guide](docs/guides/deployment.md) for this cooperative fence;
direct server entrypoints do not claim it.

The repository ships a `Dockerfile` and `docker-compose.yml`. The UI, HTTP API,
and event streams share the exposed origin on port 3000; the home persists in a
named volume. Voice has a separate WebSocket listener and is not exposed by
that single-port mapping. You can build the image from this checkout and select it
with `STATION_IMAGE`; Compose otherwise names `ghcr.io/kontourai/station:latest`.
The existence of that default does not establish registry availability. The
[deployment guide](docs/guides/deployment.md) covers the source build, binding
a workspace directory, and running it behind your own authenticated ingress.

## First steps

1. Open **Connections** and choose **Add model connection** (a local or
   hosted model service) or **Add engine** (an installed agent CLI). Startup
   can register supported native CLIs and their default Agents; check their
   readiness before starting work. The [Connections guide](docs/guides/connections.md)
   lists the engines and adoption rules.
2. Open a local project.
3. Start a direct chat for a quick question, or create a Task for work you
   want to keep.
4. Follow the Task's execution and inspect the evidence its workflow records.

If something is not ready, Station keeps the setup action visible. Run
`station doctor` for a local diagnosis. The
[Connections guide](docs/guides/connections.md) lists the current model
services and agent engines with their exact setup steps.

## For developers

| Area | Start here |
| --- | --- |
| Plugins and the SDK | [Build your first plugin](docs/guides/build-your-first-plugin.md), [plugin guide](docs/guides/plugins.md), [SDK reference](docs/reference/sdk.md), [runnable examples](examples/README.md) |
| CLI | [CLI reference](docs/reference/cli.md) for target and credential setup; `npx @kontourai/station-cli@latest --help` shows the published client's help |
| HTTP API and contracts | [API reference](docs/reference/api.md), [endpoint authorities](docs/reference/endpoints.md), [contracts](docs/reference/contracts.md) |
| Integrating Station | [Integrating Station into your company or project](docs/guides/integrating-station.md) |
| Architecture | [System overview and reading path](docs/architecture.md), [module interfaces and evidence](docs/architecture/module-map.md), [CONTEXT.md](CONTEXT.md), [design records](docs/design/README.md) |
| Operating | [Deployment](docs/guides/deployment.md), [computer relationships](docs/guides/machine-relationships.md), [config reference](docs/reference/config.md) |
| Releases | [Release rings](docs/guides/release-rings.md), [Nightly](docs/guides/nightly.md), [channel ports](docs/guides/release-channel-ports.md) |

Published packages:
[`@kontourai/station-sdk`](https://www.npmjs.com/package/@kontourai/station-sdk) (plugin SDK),
[`@kontourai/station-cli`](https://www.npmjs.com/package/@kontourai/station-cli) (client),
[`@kontourai/station-contracts`](https://www.npmjs.com/package/@kontourai/station-contracts) and
[`@kontourai/station-shared`](https://www.npmjs.com/package/@kontourai/station-shared) (server, connection, and orchestration contracts plus shared helpers).

Station is built on Kontour's published primitives — Surface, Flow, Veritas,
Survey, and Flow Agents — through the same packages and contracts available to
any consumer. Learn more at [kontourai.io](https://kontourai.io).

## Documentation

The rendered [documentation site](https://kontourai.github.io/station/docs/)
publishes the end-user guides. The [documentation map](docs/README.md) routes
users, operators, plugin authors, contributors, and maintainers to everything
else in the repository.

For a guided overview-to-code path, use [Learn Station](docs/learn/README.md).
Its local interactive atlas connects concepts, module interfaces, canonical
documents, implementation, and evidence; Station Docs MCP draws from the same
manual and architecture sources.

## Contributing and support

- [Contributing](CONTRIBUTING.md) — issue-first, safe-direct, and
  discuss-first paths, source setup, and the pull-request contract.
- [Support](https://kontourai.io/support/) — setup and usage questions.
- [Security policy](SECURITY.md) — report vulnerabilities privately.

## Data and privacy

Networked features have their own settings and destinations: Model connections,
Engines, remote computers, notification services, authentication providers, and
telemetry exporters can exchange data outside the local home. Some configured
features make startup or background requests; desktop builds also contact
their release feed. Read the repository's [data-flow inventory and review limits](docs/privacy-policy.md)
alongside the [public privacy policy](https://kontourai.io/privacy/station/).
Generated store declarations are not proof that every data flow has been assessed.

## License

Station is available under the [Apache License 2.0](LICENSE).
