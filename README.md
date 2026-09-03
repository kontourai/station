# Station

**Do the work. See the gates. Keep the receipts.**

Station is Kontour's local-first agent workspace. It keeps projects, Tasks,
Sessions, evidence gates, readiness, and receipts in one place while letting
you work with Station agents and supported external engines.

## Why Station

Most agent tools stop at an answer or a diff. Station keeps the work and the
reason it is allowed to advance together.

- **One project context** — Tasks, Sessions, changed files, artifacts, and
  receipts stay connected.
- **Your choice of connection** — use a local model, a hosted model service, or
  an external engine without exposing transport details as product concepts.
- **Visible trust state** — gates, missing evidence, route-backs, exceptions,
  and readiness remain beside the work they describe.
- **Local-first ownership** — Station data lives under `~/.station` by default,
  and outbound Providers or observability endpoints are explicit choices.
- **An extensible workspace** — plugins can add layouts, agents, tools,
  knowledge, Providers, registries, skills, and settings.

## Install

When a signed stable ring manifest is published, the installer supports macOS and Linux. It requires
Node.js 24.x, npm 10 or newer, git, curl, tar, and an authenticated
[GitHub CLI](https://cli.github.com/) session for release attestation checks.
On Linux, compiling the `node-pty` terminal module additionally needs a C++
toolchain (`g++`, `make`, `python3`) until attested Linux prebuilds are
pinned in `packaging/node-pty-prebuilds/`; macOS and Windows use upstream
prebuilds and need no compiler.

```bash
sh -c 'set -eu; file=$(mktemp "${TMPDIR:-/tmp}/station-install.XXXXXX"); trap '\''rm -f "$file"'\'' EXIT HUP INT TERM; curl -fsSL https://raw.githubusercontent.com/kontourai/station/main/install.sh >"$file"; chmod 600 "$file"; GH_TOKEN=$(gh auth token) sh "$file"'
```

The installer verifies a published release's GitHub OIDC attestation and SHA-256
receipt, installs stable Station under `~/.station/installs/stable`, links
`station` into `~/.local/bin`, and opens the local UI at
`http://localhost:18000`. Running the same command again upgrades in place
while preserving its runtime under `~/.station/instances/stable`. When a signed
beta ring is published, it uses `STATION_CHANNEL=beta`, `station-beta`, and
`~/.station/instances/beta`; both share client profiles at
`~/.station/config/profiles.json`.

For first launch, Provider setup, updates, and uninstall instructions, read
[Getting started](docs/user/getting-started.md).

## Start Working

Station detects available connections, including local model services and
supported external engines. You do not need to configure every connection
before you begin.

1. Open Station at `http://localhost:18000`.
2. Choose or add a connection in **Connections**.
3. Open a local project.
4. Start a Task or a direct chat with the agent you want.

If the workspace is not ready, Station keeps the setup action visible. Run
`station doctor` for a local diagnosis.

## Documentation

- [Getting started](docs/user/getting-started.md) — install, first launch,
  Provider setup, updates, and uninstall.
- [Station concepts](docs/user/concepts.md) — the user-facing vocabulary for
  Stations, agents, Providers, Projects, Tasks, Sessions, and receipts.
- [Keyboard shortcuts](docs/guides/keyboard-shortcuts.md) — customize commands
  on this device.
- [Release channel ports](docs/guides/release-channel-ports.md) — channel
  homes, ports, launchers, and provenance.
- [Documentation map](docs/README.md) — routes for users, operators, plugin
  authors, contributors, and maintainers.
- [Contributing](CONTRIBUTING.md) — source setup, repository architecture,
  testing, and documentation maintenance.

## Data And Privacy

Station is self-hosted. It does not use data for cross-app or cross-site
tracking. Data leaves the device only when a user or operator configures a
Provider or endpoint and uses the applicable feature. See the
[Station privacy policy](https://kontourai.io/privacy/station/).

## License

Station is available under the [Apache License 2.0](LICENSE).
