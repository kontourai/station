# Station Documentation

Station documentation is organized by audience and authority. Start with the
row that matches the job you are doing.

| Audience | Start here | Publication |
| --- | --- | --- |
| Product evaluators and end users | [../README.md](../README.md), [user/getting-started.md](user/getting-started.md), [user/concepts.md](user/concepts.md) | Public |
| Operators | [guides/deployment.md](guides/deployment.md), [guides/machine-relationships.md](guides/machine-relationships.md), [reference/config.md](reference/config.md) | Repository only unless explicitly listed in the public manifest |
| Release operators | [guides/ecosystem-packaging.md](guides/ecosystem-packaging.md), [guides/store-entry.md](guides/store-entry.md), [guides/store-listing.md](guides/store-listing.md) | Owner-gated Homebrew, public installer plumbing, and store consoles |
| Plugin authors | [guides/plugins.md](guides/plugins.md), [guides/build-your-first-plugin.md](guides/build-your-first-plugin.md), [reference/sdk.md](reference/sdk.md) | Repository only |
| Contributors | [../CONTRIBUTING.md](../CONTRIBUTING.md), [architecture/module-map.md](architecture/module-map.md), [guides/development.md](guides/development.md), [guides/testing.md](guides/testing.md) | Repository only |
| Maintainers and agents | [../AGENTS.md](../AGENTS.md), [strategy/README.md](strategy/README.md), [glossary.md](glossary.md) | Repository only |
| API and CLI consumers | [reference/api.md](reference/api.md), [reference/cli.md](reference/cli.md), [reference/contracts.md](reference/contracts.md) | Repository only |

## Choose a path

### Product and marketing

Start with the [project README](../README.md), then use [Getting started](user/getting-started.md)
and [Station concepts](user/concepts.md) to understand the product, its
local-first data boundary, and its work vocabulary. These pages describe
outcomes and user-visible behavior without depending on a particular external
engine.

### Developer and operator

Use the [development guide](guides/development.md), [plugin authoring guide](guides/build-your-first-plugin.md),
[SDK reference](reference/sdk.md), [API reference](reference/api.md), and [CLI
reference](reference/cli.md) for implementation, extension, and integration
work. These documents may name a specific protocol or supported integration
when that detail is required to configure or test the interface.
The [example catalog](../examples/README.md) groups runnable fixtures by
contract and states which live-provider paths remain unverified.

## Authority

- [glossary.md](glossary.md) owns canonical Station vocabulary.
- [CONTEXT.md](../CONTEXT.md) owns product and domain context.
- [architecture/module-map.md](architecture/module-map.md) routes contributor
  implementation work.
- GitHub issues and pull requests own live work state. Strategy and phase
  records do not replace a live issue query.
- Source and tests own runtime truth. Historical plans, audits, and receipts
  explain prior decisions but do not become current contracts by being linked.

When two documents conflict, use the more local authority above and fix or
clearly mark the stale document.

## Repository Documentation

- **[Guides](guides/)** — task-oriented operator, plugin, and contributor docs.
- **[Reference](reference/)** — API, CLI, config, SDK, and contract details.
- **[Architecture](architecture/)** — current module boundaries and ownership.
- **[Cloud move](design/cloud-move.md)** — setup preview, AWS preparation, and
  the staged path to verified execution handoff.
- **[Private cloud environment](design/private-cloud-environment.md)** — working
  single-VM deployment and execution design.
- **[Design records](design/README.md)** — proposals, accepted decisions, and
  superseded designs. A design file is not current merely because it remains
  in the repository; read its status and follow its named successor.
- **[Strategy](strategy/)** — durable identity, decisions, historical phase
  records, and maintainer execution context. Repository contents are public;
  exclusion from Pages is not a privacy boundary.
- **[Plans](plans/)** — implementation plans and staged initiatives; lifecycle
  and current work status must be checked against the owning GitHub issue.
- **[Migration records](migration/)** — cutover-era identifier maps retained for
  historical lookup; GitHub issues and pull requests remain the authority for
  live work.
- **[Patterns](patterns/)** — frontend and backend implementation conventions.
- **[ADRs](adr/)** — numbered architecture decision records; supersession is
  recorded inside the record or by a named successor.
- **[Contexts](contexts/)** — per-area `CONTEXT.md` files routed from
  [../CONTEXT-MAP.md](../CONTEXT-MAP.md).
- **[Conformance](conformance/)** — external-contract conformance notes.
- **[Security](security/)** — security design notes; disclosure policy lives
  in [../SECURITY.md](../SECURITY.md).
- **[Testing](testing/)** — supplementary testing records; the canonical
  guide is [guides/testing.md](guides/testing.md).
- **[Third-party](third-party/)** — vendored/external integration notes.
- **[UI](ui/)** — ratchet and exception baselines consumed by `scripts/*-ratchet.mjs`
  (data files, not prose).
- **[Pages](pages/)** — the public-site source boundary (see below).

Root-level records: [glossary.md](glossary.md) (vocabulary authority),
[architecture.md](architecture.md) (defers to the module map),
[acp-chat-architecture.md](acp-chat-architecture.md) (historical proposal),
[strands-migration.md](strands-migration.md) (historical assessment),
[privacy-policy.md](privacy-policy.md), and
a historical audit retained in the repository archive.
User-facing docs not named in the audience table:
[user/native-recovery.md](user/native-recovery.md),
[user/work-board.md](user/work-board.md), and
[user/contributing.md](user/contributing.md).

## Public Site

For file placement, naming, source authority, and retiring old material, use
[Maintaining documentation](guides/documentation.md). For code and tooling
placement, use [Repository layout](guides/repository-layout.md).

The public site is an intentionally small product and end-user projection. Its
source boundary is:

- `docs/pages/index.html` and `docs/pages/styles.css` for the marketing home.
- `docs/pages/public-docs.json` for the exact Markdown allowlist.

The generator does not recursively publish `docs/`. Strategy, architecture,
plans, audits, and historical receipts remain available in the repository but
are not presented as end-user marketing.

Run:

```bash
npm run docs:pages:build
```

The build writes disposable output to `dist-pages/` and checks every emitted
HTML file. Do not edit generated output by hand.

`npm run docs:links:check` validates relative links in every tracked Markdown
and MDX file, including examples and historical records. `npm run
docs:index:check` proves the generated file indexes in `design/README.md` and
`plans/README.md` match their tracked files (regenerate with `npm run
docs:index`), and `npm run docs:hygiene:repo` sweeps every tracked markdown and `.jsonl` record
under `docs/` for machine-specific detail that belongs outside documentation; its
allowlist in `scripts/docs-hygiene-grandfather.json` is staleness-checked in
both directions, and adding to it is reserved for historical records whose
text cannot change without falsifying them. All three run
inside `docs:truth:gate`. `npm run
examples:conformance -- --build` validates every example manifest and README
command contract, then builds every example that declares a build script.
