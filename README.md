# Station

**The agent workspace where work ships with receipts.**

Station is Kontour's open-source, local-first workspace for agent work. Bring
your agents, projects, and devices together, hand a Task to the agent you
choose, and keep the gates, evidence, and receipts beside the work so "done"
means proven rather than asserted.

[Product site](https://station.kontourai.io) ·
[Documentation](https://kontourai.github.io/station/docs/) ·
[Getting started](docs/user/getting-started.md) ·
[Concepts](docs/user/concepts.md) ·
[Contributing](CONTRIBUTING.md)

> **Status:** open source under active development (Apache-2.0). Run Station
> from source on macOS or Linux today, or try the macOS Nightly desktop build.
> A verified installer ships with the first stable release. See
> [Get Station](#get-station).

## Why Station

Most agent tools stop at an answer or a diff. Station keeps the work and the
reason it is allowed to advance together.

- **Evidence over confidence** — work ends as passed gates with fresh
  evidence, an exception a person explicitly accepted, or `NOT_VERIFIED`
  stated plainly. Gate outcomes, missing evidence, route-backs, and receipts
  stay beside the work instead of being reconstructed from a transcript.
- **Supported engines, one workspace** — run Station agents on a local or
  hosted model, or connect supported agent CLIs and compatible custom engines
  as External agents. Each engine keeps its own behavior and tool loop;
  Station supplies the project context, the gates, and the record.
- **Work that outlives a chat** — Projects, Tasks, Sessions, changed files,
  artifacts, and receipts stay linked. Reopen a Task later with its workspace
  binding and evidence intact.
- **Your devices, your Station** — pair a phone, tablet, or laptop to your
  Station with scoped, revocable access, and delegate work to another
  computer you own over SSH.
- **Local-first ownership** — Station data lives under `~/.station` by
  default. Hosted Model connections, Engines, paired devices, remote
  computers, and export endpoints carry your data only when you configure
  and use them; desktop builds also check their release feed for updates.
- **Built to extend** — plugins add layouts, agents, tools, knowledge,
  connections, skills, and purpose-built work surfaces on the same SDK the
  core uses.

## What people use it for

| You want to… | In Station |
| --- | --- |
| Ship a code change you can stand behind | Open the repository as a Project, create a Task, pick an agent, and keep the commands that ran, their results, and the review receipts with the change. |
| Keep a long piece of work alive | A Task spans as many Sessions as it needs. Follow it from a paired device and come back to the same context, files, and evidence. |
| Use agents without a cloud account | Point a Station agent at a local model server. Inference stays on this machine, and every other data-carrying connection is one you add yourself. |
| Coordinate several agents | Delegate bounded work from one agent to another, or run it on a remote computer over SSH with that machine's own agents, credentials, and workspace. |
| Run Station on a server you control | Build the container image from this checkout, run it behind your own authenticated ingress, and pair devices with scoped, revocable access. |
| Build a purpose-built work surface | Write a plugin: a review workbench, a release console, a domain-specific layout. Plugins get the same primitives as the core. |

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

### Nightly desktop build (macOS, Apple silicon)

A rolling [Nightly desktop pre-release](https://github.com/kontourai/station/releases/tag/nightly-desktop)
is published from `main` for testers. It installs alongside a stable Station
and updates through its own channel. Expect rough edges; it is not a stable
release.

### Verified installer (when a stable release is published)

Stable and beta portable releases are signed GitHub release rings. No ring has
been published yet. Once one exists, the bootstrap below verifies the release's
GitHub OIDC attestation and SHA-256 receipt before installing under
`~/.station/installs/stable`, linking `station` into `~/.local/bin`, and
opening the UI at `http://localhost:18000`. It requires Node.js 24.x, npm 10
or newer, git, curl, tar, and an authenticated
[GitHub CLI](https://cli.github.com/) session for the attestation check.

```bash
sh -c 'set -eu; file=$(mktemp "${TMPDIR:-/tmp}/station-install.XXXXXX"); trap '\''rm -f "$file"'\'' EXIT HUP INT TERM; curl -fsSL https://raw.githubusercontent.com/kontourai/station/main/install.sh >"$file"; chmod 600 "$file"; GH_TOKEN=$(gh auth token) sh "$file"'
```

Running the same command again upgrades in place. Set `STATION_CHANNEL=beta`
for the beta ring, which uses `station-beta` and `http://localhost:28000`.
[Getting started](docs/user/getting-started.md) covers channels, updates, and
uninstall.

### Self-host with Docker

The repository ships a `Dockerfile` and `docker-compose.yml`. Station serves
its UI, API, and streaming from one origin on port 3000 and persists its home
in a named volume. Build the image from this checkout today: the Compose
file's default published image is not yet available for anonymous pulls. The
[deployment guide](docs/guides/deployment.md) covers the source build, binding
a workspace directory, and running it behind your own authenticated ingress.

## First steps

1. Open **Connections** and choose **Add model connection** (a local or
   hosted model service) or **Add engine** (an installed agent CLI). Station
   detects what is already on the machine but never connects anything without
   you.
2. Open a local project.
3. Start a direct chat for a quick question, or create a Task for work you
   want to keep.
4. Watch gate state, evidence, route-backs, and receipts accumulate beside the
   Task.

If something is not ready, Station keeps the setup action visible. Run
`station doctor` for a local diagnosis. The
[Connections guide](docs/guides/connections.md) lists the current model
services and agent engines with their exact setup steps.

## For developers

| Area | Start here |
| --- | --- |
| Plugins and the SDK | [Build your first plugin](docs/guides/build-your-first-plugin.md), [plugin guide](docs/guides/plugins.md), [SDK reference](docs/reference/sdk.md), [runnable examples](examples/README.md) |
| CLI | [CLI reference](docs/reference/cli.md); `npx @kontourai/station-cli@latest --help` runs the published client against any Station |
| HTTP API and contracts | [API reference](docs/reference/api.md), [endpoint authorities](docs/reference/endpoints.md), [contracts](docs/reference/contracts.md) |
| Integrating Station | [Integrating Station into your company or project](docs/guides/integrating-station.md) |
| Architecture | [Module map](docs/architecture/module-map.md), [CONTEXT.md](CONTEXT.md), [design records](docs/design/README.md) |
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

## Contributing and support

- [Contributing](CONTRIBUTING.md) — issue-first, safe-direct, and
  discuss-first paths, source setup, and the pull-request contract.
- [Support](https://kontourai.io/support/) — setup and usage questions.
- [Security policy](SECURITY.md) — report vulnerabilities privately.

## Data and privacy

Station is self-hosted. It does not use data for cross-app or cross-site
tracking. Your work leaves the device only when a user or operator configures a
networked feature, such as a hosted Model connection, an Engine, a paired
device, a remote computer, or an export endpoint, and uses it; desktop builds
also contact their release feed to check for updates. See the
[Station privacy policy](https://kontourai.io/privacy/station/).

## License

Station is available under the [Apache License 2.0](LICENSE).
