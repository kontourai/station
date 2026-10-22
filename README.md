# Station

**The agent workspace where work ships with receipts.**

[![Docs](https://img.shields.io/badge/docs-kontourai.github.io-blue)](https://kontourai.github.io/station/)
[![Site](https://img.shields.io/badge/site-station.kontourai.io-blue)](https://station.kontourai.io)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

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
> using a signed Nightly server archive or a Nightly desktop build.
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
- **Built to extend** — build on Station's core capabilities through its public
  SDK and plugin APIs. Add layouts, agents, tools, knowledge, connections, skills,
  and work surfaces to shape the workspace around your work. Start with the
  included experience and extend it with your own plugins.

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

### Install the app

For a first try, use the [Nightly desktop downloads](docs/user/getting-started.md#nightly-desktop-downloads)
for macOS Apple silicon or Windows x64. Download the installer for your computer,
open it, and launch Station. Nightly is a testing channel; see the linked guide
for signing and platform limitations.

### One-command server install

On macOS or Linux, paste this into Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/kontourai/station/main/install.sh | STATION_CHANNEL=nightly sh
```

The signed Nightly archive includes Node.js. You do not need Git, a GitHub
account, or a source build. The installer starts Station and prints a sign-in
link. Later, launch it with:

```bash
~/.local/bin/station-nightly start
```

Using the full path works before your shell knows the `station-nightly` command.
For Windows PowerShell, updates, and connection help, follow
[Getting started](docs/user/getting-started.md#install-nightly).

### On your phone

Connect to a Station running on a computer. The phone uses that computer’s
agents and files; it does not need Node.js or coding tools. The phone apps are
in internal testing (Google Play internal testing and TestFlight), so most
people open the Station's address in the phone's browser. Follow
[Connect your phone](docs/user/getting-started.md#connect-your-phone).

<a id="run-from-source-macos-linux"></a>

### For contributors: run from source

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

### Other ways to run Station

[Getting started](docs/user/getting-started.md) is the single owner of the install
steps. Use it for:

- the Windows PowerShell Nightly install, updates and uninstall;
- the [verified installer](docs/user/getting-started.md#install-or-upgrade)
  for a published stable or beta release ring, and the signed
  prebuilt-archive path;
- [the release list](https://github.com/kontourai/station/releases) and
  [release rings](docs/guides/release-rings.md) for what is currently published.

To self-host on a server with Docker or Compose, follow the
[deployment guide](docs/guides/deployment.md). It covers building the image,
home ownership, binding a workspace, and putting Station behind your own
authenticated ingress.

## First steps

1. Open **Customize → Connections** and choose **Add model connection** (a local or
   hosted model service) or **Add engine** (an installed agent CLI). Startup
   can register supported native CLIs and their default Agents; check their
   readiness before starting work. The
   [Connections guide](docs/guides/connections.md#add-an-engine) lists the
   engines Station knows by name and how startup adopts them.
2. Open a local project.
3. Start a chat for ordinary work. Chats retain their history. Create a Task
   when you need a tracked deliverable or workflow.
4. Follow the Task's execution and inspect the evidence its workflow records.

To connect a phone, start Station on your computer and create a pairing code,
then choose **Scan QR code** on the phone. **Nearby Stations** is an optional
local-network path when the computer's discovery setting is enabled. Follow
[Connect your phone](docs/user/getting-started.md#connect-your-phone) for address,
manual-entry and approval steps.

If something is not ready, Station keeps the setup action visible. Run
`station doctor` for a local diagnosis.

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
