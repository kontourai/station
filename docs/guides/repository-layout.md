# Repository layout

Choose a directory here, then read its local instructions and the relevant
section of the [module map](../architecture/module-map.md), which owns detailed
interfaces and composition rules.

## Runtime and product code

| Directory | Responsibility |
| --- | --- |
| `src-server/` | HTTP routes, services, persistence, engine adapters, runtime composition |
| `src-ui/` | React application, workspace navigation, product UI |
| `src-desktop/` | Tauri shell and native platform integration |
| `src-shared/` | Checkout-level shared source |
| `packages/` | Contracts, SDK, shared helpers, pairing, CLI, and pane packages |
| `examples/` | Documented plugin and integration examples |
| `experiments/` | Experiments with explicit limitations, not implied product support |

New cross-package types belong in their owning module in `packages/contracts/`.
Keep compatibility re-exports in `packages/shared/` for existing consumers.
Consume sibling Kontour products through published interfaces. The
[development guide](development.md#packages) explains package distribution.

## Tooling and documentation

| Directory | Responsibility |
| --- | --- |
| `scripts/` | Build, verification, maintenance, and release command implementations |
| `tests/` | End-to-end suites, live probes, and manifests; unit tests also live beside their owners |
| `config/`, `schemas/` | Checked-in configuration and validation schemas |
| `packaging/`, `patches/` | Distribution inputs and managed dependency patches |
| `ops/` | Station-specific operational launch and release helpers |
| `monitoring/` | Optional observability stack |
| `assets/` | Application assets |
| `docs/` | Guides, references, decisions, and public-site sources |
| `.github/`, `.githooks/` | Hosted workflows, contribution forms, local hooks |
| `.veritas/`, `.flow/`, `.agents/` | Governance and agent workflow inputs |

The root holds discovery files and configuration whose tools expect it there.
Avoid adding one-off reports or alternative startup scripts at the root. Use
[Maintaining documentation](documentation.md) for document placement and
retirement. Builds and runtime evidence belong in their established ignored
output locations. Some generated source is deliberately tracked; preserve its
generator and check command when changing it.

## Naming and refactoring

Follow the owning directory's existing convention for code filenames, exported
symbols, and colocated tests. Use the [glossary](../glossary.md) for product
terms. Naming changes must update imports, exports, tests, and docs together;
a public contract rename needs an explicit compatibility decision.

Move code to clarify ownership or isolate behavior behind a testable interface.
Before splitting a large module, identify its callers, invariant owner, and
behavioral tests in the module map. A generic utility directory alone does not
establish that boundary.

## Agent navigation

Start with [AGENTS.md](../../AGENTS.md), inspect checkout state, and read the
routed instructions for the changed paths. Search by a user operation, route,
or exported symbol before reading an entire subsystem. Use the module map's
index to select the relevant section.

Run `npm run gate:for -- <changed-paths...>` before editing. Inspect test
selection with `npm run test:changed -- --base=origin/main --explain` and execute
selected tests with `npm run test:focused -- <selected-test-files...>`. Follow
[Testing](testing.md) for escalation and receipt meaning: an explanation or a
deferred result is not a completed test run.
