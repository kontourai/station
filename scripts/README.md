# Scripts

Executable repository tooling: gates, ratchets, generators, release and install
tooling, and the lab and smoke runners behind them. `scripts/AGENTS.md` holds the
rules for writing one. This page only says where to look.

Most entries are wired through a `package.json` script. Start from the script
name (`npm run gate:for -- <paths>` names the checks a change feeds) rather than
the file name, and use the [testing guide](../docs/guides/testing.md) for what runs
when. Its schedule is generated from `scripts/verification-lanes.mjs`.

## Directories

| Path | Purpose |
| --- | --- |
| `scripts/*.mjs`, `*.mts`, `*.ts` | Entry points, run directly with `node` or `tsx`. |
| `scripts/lib/` | Shared helpers imported by entry points and tests. Prefer extending one over writing a local copy: `bounded-capture.mjs` for child-process output, `canonical-json.mjs` for hashed JSON, `owned-process.mjs` for process-tree ownership. |
| `scripts/__tests__/` | Vitest suites for the entry points and helpers above. A test that spawns a child process is classified in `scripts/vitest-resource-manifest.mjs`. |
| `scripts/fixtures/` | Inputs and small executable helpers (capture and probe servers) used by tests and by `region-grid-parity.mjs`. |
| `scripts/templates/` | Android and iOS project templates copied by the native build scripts. |
| `scripts/bench/` | Hand-run benchmarks. Not part of any gate. |

## Entry points by purpose

File names group by prefix, so a pattern finds the family.

| Purpose | Look for |
| --- | --- |
| Choosing and running verification | `verification-lanes.mjs` (lane catalog), `run-verification.mjs`, `run-ci-fast.mjs`, `run-focused-tests.mjs`, `run-changed-verification.mjs`, `gate-for.mjs`, `run-full-regression-phases.mjs`, `tsc-slot.mjs` |
| Gates and ratchets (fail on a violation or on growth) | `*-gate.mjs`, `*-ratchet.mjs` with a paired `*-baseline.json`; baselines only shrink |
| Proof lanes for Veritas | `proof-family-lane.mjs`, `proof-repo-guardrails.mjs`, `evidence-check-execution-gate.mjs` |
| Documentation | `docs-*.mjs`, `documentation-impact.mjs`, `check-documentation-freshness.mjs`, `record-documentation-review.mjs`, `generate-*.mjs` (generated references), `build-learning-guide.mjs` |
| Dependencies and supply chain | `dependency-*.mjs`, `lockfile-sync-gate.mjs`, `generate-*sbom*.mjs`, `verify-npm-registry-provenance.mjs` |
| CI and PR automation | `classify-ci-change.mjs`, `ci-health.mjs`, `landing-automation.mjs`, `merge-queue-*.mjs`, `pr-*.mjs`, `main-health-comment-policy.mjs`, `hygiene-report.mjs` |
| Release, nightly and publishing | `release-*.mjs`, `nightly-*.mjs`, `portable-*-publication.mjs`, `publish-*.mjs`, `deploy-ledger.mjs`, `ecosystem-*.mjs` |
| Installer | `install-script-generated.mjs`, `smoke-install-*`; the installer itself is `install.sh` at the repository root |
| Desktop, Android and iOS builds | `build-desktop*.mjs`, `stage-desktop-server-runtime.mjs`, `*android*`, `*ios*`, `windows-*`, `write-*-build-manifest.mjs` |
| Dogfood, smoke and labs | `station-dogfood-*.mjs`, `station-agent-smoke.mjs`, `*-lab.ts`, `*-smoke.*`, `daily-driver-*.mjs` |
| Local developer tooling | `station-dev.mjs`, `dev-server-watch.mts`, `dev-desktop.mts`, `install-git-hooks.mjs`, `install-playwright-browsers.mjs`, `worktree-hygiene.mjs`, `just-interface.mjs` |

## Adding one

Put shared logic in `scripts/lib/`, give the entry point a test in
`scripts/__tests__/`, classify a child-process test in the resource manifest, and
wire the script in `package.json` or a workflow so it has a caller.
`npm run hygiene:report` runs six advisory checks: `UNWIRED`/`SUNSET` markers
whose issue is closed, issue references that cannot be Station issues, private
plan and review labels, unowned modules, stale design status, and dated evidence
with no retention rule (see [code hygiene](../docs/guides/code-hygiene.md)). It
does not find dead code; `npm run fallow` and `npm run audit:code-health` do.
