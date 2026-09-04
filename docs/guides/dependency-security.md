# Dependency security

Station treats the npm v3 lockfiles at the repository root, `packages/sdk`, and
`packages/shared` as separate product dependency surfaces. The live policy is:

## Lifecycle scripts are reviewed capabilities

`.npmrc` disables npm lifecycle scripts by default. Install dependencies through
`npm run dependencies:ci` (clean CI/install) or `npm run dependencies:install`
(developer install), never raw `npm ci`/`npm install` or a lifecycle-enabling
flag. The repo-owned runner validates the root, SDK, and Shared lock policies
before its one inert root workspace install. It preflights every installed root
lifecycle package's exact identity and complete preinstall/install/postinstall
set before permitting any reviewed command. The SDK and Shared locks are
separate audited consumer surfaces, not extra installs during root bootstrap.
It verifies the
recorded artifact afterward and runs Station's Node contract,
`patch-package`, and git-hook setup as visible Station-owned steps.

`npm run dependencies:check` fails on an unknown, nested-path, version,
integrity, lifecycle marker, platform, or stale-entry change. `npm run
dependencies:propose` emits a review starting point; it is not an approval.
Every approval names an owner, reason, artifact proof, purl, and dependency
refresh/removal/advisory trigger. The release SBOM context carries the exact
allowlist digest and purls. Windows native proof remains a platform receipt,
not something inferred from Linux or macOS.

```bash
npm run audit:policy
```

The command runs full-graph and `npm audit --omit=dev --json` production checks.
Run locally it covers all three scopes. In CI, pull-request, push and
merge-queue runs cover the scopes whose dependency inputs the change touched
(see below); the scheduled scan always covers all three, which is what makes it
a backstop rather than a second copy of the same narrowing. It fails for every
critical or high advisory that is not fixed or exactly matched by a current
exception, and for every production moderate or low advisory that is not
exactly matched by a current residual record. It also fails for malformed,
expired, duplicate, severity-mismatched, or unused records. Blocking audit
records must resolve through an acyclic `via` graph to concrete advisory
identities, and npm's blocking metadata counts must match the records. Audit
subprocess signals and operational exit statuses also fail closed.

Each actual audit attempt retains bounded, structured phase diagnostics under
`.kontourai/verification-output/dependency-audit/`. Separate started and terminal
facts distinguish interrupted work from settled children; retries keep distinct
identities. Completed npm phase timings, bulk response status/duration, actual
tool versions and child elapsed/status are observations, not policy verdicts.
The child uses npm's info log level so actual version messages and HTTP timing
messages are both emitted; the narrower HTTP level suppresses version messages.
Missing phase completion is unknown, not zero. Package names, raw URLs, config,
advisory payloads and npm debug output are never copied into these artifacts.
Private npm timing files are removed after child settlement; a hard interruption
may leave them in the operating system's temporary directory, outside upload
roots. CI and scheduled scans retain the bounded diagnostics even after failure.
This instrumentation does not change scan scopes, concurrency, retries,
deadlines, or the advisory floor. Missing diagnostic storage is reported without
changing the audit outcome.

## Local CodeQL SARIF policy

The hosted security-analysis workflow is a JavaScript/TypeScript source scan
with `security-extended` queries and no build. It writes the action's documented
`javascript.sarif` output into job-temporary storage, requires exactly one such
file, then uses the checker read from the exact base commit—not the candidate
checkout—to bounded-read, strict-parse, and atomically canonicalize it before
semantic enforcement. Its 30-minute job limit is deliberate headroom over a
10m55 successful security-extended analysis, not an unbounded retry window. It
runs on a disposable GitHub-hosted runner and deliberately uses
`upload: never`: this repository does **not** claim that GitHub ingests or
displays the result.

When a CodeQL SARIF file is available locally, validate its evidence before
using it in a review:

```bash
npm run codeql:sarif:check -- --input=/absolute/path/to/codeql.sarif
```

The local policy rejects empty, malformed, truncated, synthetic, or failed
analysis evidence; it requires an identified CodeQL run, rule inventory,
valid rule references, result messages, and severity resolved from the result
or its referenced rule. Any nonempty CodeQL result blocks the workflow and
prints a bounded rule/severity/message summary to the job log. A clean completed
scan may legitimately have an empty result list.

GitHub ingestion is **NOT_VERIFIED**. Rust analysis is also **NOT_VERIFIED**:
this foundation initializes only `javascript-typescript` and does not build or
analyze Rust. Do not infer coverage of native code, a hosted finding, or a
repository security-alert state from this workflow.

## Hosted dependency review

For pull requests, the same base-controlled workflow also calls GitHub's
`actions/dependency-review-action` directly on a disposable `ubuntu-22.04`
runner. It has read-only contents permission, checks high and critical
dependency changes (`fail-on-severity: high`), disables license checks and
warn-only behavior, and never checks out or executes candidate code. It does
not use secrets, caches, artifacts, persistent runners, or PR comments.

The capability is not assumed to be available merely because the workflow is
present: if GitHub dependency review is unavailable for the repository or its
plan, the dependency-review capability is **NOT_VERIFIED**. A missing or
unavailable capability is not a green dependency review, and this workflow
does not claim hosted advisory ingestion or GitHub alert state.

## Investigate a failure

Capture both the complete development graph and production reachability:

```bash
npm audit --json
(cd packages/sdk && npm audit --json --workspaces=false)
(cd packages/shared && npm audit --json --workspaces=false)
npm audit --omit=dev --json
```

The full audits are authoritative for CI. `--omit=dev` only explains whether a
root finding is reachable in production; it never removes a development finding
from the floor. Registry advisory data changes over time, so use the executable
report rather than copying a historical total into automation.

The full graph is never suppressed: its counts remain in the report even when
development-only moderate or low findings need no production residual record.
Production reachability is an additional exact-record requirement, not a broad
severity waiver.

Prefer the smallest compatible direct update. When a vulnerable transitive
version remains, add the narrowest compatible `overrides` entry that cannot
affect an unrelated dependency path. Regenerate every affected lock with the
repository's supported peer-resolution mode:

```bash
npm install --package-lock-only
(cd packages/sdk && npm install --package-lock-only --workspaces=false)
(cd packages/shared && npm install --package-lock-only --workspaces=false)
npm run dependencies:ci
npm run audit:policy
```

`@kontourai/station-contracts` is published on npm (0.1.0), but the SDK and
shared packages resolve it from the in-repo `packages/contracts` workspace, and
both scoped locks record that local link rather than a registry tarball. When
rebuilding either independent lock from scratch, temporarily resolve that
package as `file:../contracts`, run the scoped lock-only install with
`--workspaces=false`, then restore the published semver declaration and verify
the lock retains the local link (`"resolved": "../contracts"`, `"link": true`)
at version 0.1.0.
Never use `npm audit fix --force`; major dependency migrations require their own
review and compatibility evidence.

## Exceptions

Critical/high exceptions and production moderate/low residual records live in
`scripts/dependency-advisory-exceptions.json`. They are short-lived, exact
advisory dispositions, not package or severity allowlists. A residual record
must contain the exact `scope`, `package`, resolved `version`, `advisory`,
`severity`, and `reachability`, together with an `owner`, concrete
`disposition`, compensating `controls`, HTTPS upstream or tracking URL,
`expires`, and a `recheckTrigger`. The gate rejects a missing, mismatched,
expired, duplicate, or unused record.

Critical/high exception entries contain only:

```json
{
  "scope": "root",
  "package": "example-package",
  "advisory": "GHSA-xxxx-yyyy-zzzz",
  "severity": "high",
  "owner": "station-maintainers",
  "reason": "Why a compatible fix cannot land yet.",
  "trackingIssue": "https://github.com/kontourai/station/issues/123",
  "expires": "2026-08-01"
}
```

The scope, package, advisory identity, and severity must match exactly. The
owner reviews the tracking issue and expiry date on every dependency PR. Extend
an expiry only with fresh evidence in that issue. Remove the exception in the
same change that fixes the advisory: unused entries deliberately fail CI.

Dependabot and human pull requests run the same `npm run audit:policy` step in
the fast CI job. A Dependabot update is complete only after the same lock
inspection, policy pass, and compatibility gates required for a manual update.

That step audits the scopes whose dependency inputs the change touched, not all
three every time (#1417). This narrowing applies to `pull_request`,
`pull_request_target`, `merge_group` and `push` events only -- the scheduled
`dependency-advisory` workflow runs on `schedule`, so it always audits all
three. A change to the root lockfile audits `root`; a change
to `packages/sdk/package.json` audits `sdk`; anything the mapping cannot
attribute -- a workspace that is not itself an audited scope, any `.npmrc`, the
exceptions file -- audits all three, as does any classification that fails
closed. What this trades away is the incidental re-audit of untouched scopes
that a dependency-touching PR used to perform: an advisory newly disclosed
against a scope nobody edited is caught by the scheduled
`dependency-advisory` workflow within a day rather than by the next unrelated
pull request. It was never caught by a PR that touched no dependency input at
all, because the step skips entirely in that case.

The delta is small but it is not zero, and it is not only dev dependencies.
`packages/shared`'s closure is a subset of the root closure, and almost all of
what `packages/sdk` adds is its dev graph -- but a standalone package lockfile
can pin a PRODUCTION dependency at a version the root closure does not carry,
and `npm audit --omit=dev` at the root cannot see that version. When a
root-scoped pull request is the only audit a change receives, that is the gap
the daily scan is covering.

## 2026-07 critical/high disposition

This dated matrix records the intake snapshot. One package row can contain
multiple advisory identities because the policy evaluates each identity
independently. `Production` means the finding was present in the root
`npm audit --omit=dev` snapshot; it does not weaken the full-graph CI rule.

| Scope | Package | Advisory identities | Reachability | Disposition |
| --- | --- | --- | --- | --- |
| root | `axios` | `GHSA-pmwg-cvhr-8vh7`, `GHSA-pf86-5x62-jrwf`, `GHSA-6chq-wfr3-2hj9`, `GHSA-q8qp-cvcw-x6jj`, `GHSA-hfxv-24rg-xrqf`, `GHSA-777c-7fjr-54vf`, `GHSA-p92q-9vqr-4j8v`, `GHSA-j5f8-grm9-p9fc`, `GHSA-3g43-6gmg-66jw`, `GHSA-35jp-ww65-95wh` | Production | Override fixed at 1.18.1. |
| root | `fast-uri` | `GHSA-q3j6-qgpj-74h6`, `GHSA-v39h-62p7-jpjc` | Production | Override fixed at 3.1.3. |
| root | `form-data` | `GHSA-hmw2-7cc7-3qxx` | Production | Override fixed at 4.0.6. |
| root | `lodash` | `GHSA-r5fr-rjxr-66jc` | Development | Override fixed at 4.18.1. |
| root | `node-forge` | `GHSA-2328-f5f3-gj25`, `GHSA-q67f-28xg-22rw`, `GHSA-5m6q-g25r-mvwx`, `GHSA-ppp5-5v6c-4jwp` | Production | Override fixed at 1.4.0. |
| root | `path-to-regexp` | `GHSA-j3q9-mxjg-w52f` | Production | `router` path override fixed at 8.4.2; the unrelated Express 0.1 path remains on its compatible line. |
| root | `picomatch` | `GHSA-c2c7-rcm5-vvqj` | Production | Affected 2.x paths fixed at 2.3.2 without downgrading 4.x consumers. |
| root | `socket.io-parser` | `GHSA-677m-j7p3-52f9` | Production | Override fixed at 4.2.6. |
| root | `vite` | `GHSA-v2wj-q39q-566r`, `GHSA-p9ff-h696-f583`, `GHSA-fx2h-pf6j-xcff` | Development | Direct dependency fixed at 7.3.6. |
| root | `vitest` | `GHSA-5xrq-8626-4rwp` | Development | Root, Connect, and SDK fixed at 3.2.6; coverage aligned at 3.2.6. |
| root | `ws` | `GHSA-96hv-2xvq-fx4p` | Production | Direct dependency fixed at 8.21.0; `engine.io-client` fixed at 6.6.6 so its nested `ws` selects 8.21.0. |
| shared | `@hono/node-server` | `GHSA-wc8c-qw6v-h7f6` | Production | Regenerated shared lock selects 1.19.14. |
| shared | `express-rate-limit` | `GHSA-46wh-pxpv-q5gq` | Production | Regenerated shared lock selects 8.3.1 or newer compatible 8.x. |
| shared | `fast-uri` | `GHSA-q3j6-qgpj-74h6`, `GHSA-v39h-62p7-jpjc` | Production | Regenerated shared lock selects 3.1.3. |
| shared | `hono` | `GHSA-q5qw-h33p-qvwr`, `GHSA-88fw-hqm2-52qc` | Production | Regenerated shared lock selects 4.12.25 or newer compatible 4.x. |
| shared | `path-to-regexp` | `GHSA-j3q9-mxjg-w52f` | Production | Regenerated shared lock selects 8.4.2. |

The final 2026-07 policy run reports no unaccepted critical/high advisory in
root, SDK, or shared. No exception was required.

## 2026-08 production residual inventory

The 2026-08-08 root `npm audit --omit=dev --json` snapshot has zero critical
or high findings, 18 propagated moderate records, and six propagated low
records. They resolve to the exact five `residuals` entries enforced by
`npm run audit:policy`; the full root graph reports 26 moderate and six low
records because eight moderate records are development-only. Recheck every row
by **2026-09-08**, or immediately when the named upstream releases a
compatible version.

| Package / version | Advisory | Production reachability and current control | Recheck source |
| --- | --- | --- | --- |
| `@hono/node-server@1.19.15` | [`GHSA-frvp-7c67-39w9`](https://github.com/advisories/GHSA-frvp-7c67-39w9) | Nested under the current `@voltagent/server-hono@2.0.14`; Station's own runtime tests import the separately resolved patched `@hono/node-server@2.0.12`, and Station has no direct `serveStatic` import. A major override is not compatible with the upstream package's `^1.14.0` declaration. | `@voltagent/server-hono` release notes and `npm audit --omit=dev --json` |
| `@opentelemetry/core@2.0.1` and `2.1.0` | [`GHSA-8988-4f7v-96qf`](https://github.com/advisories/GHSA-8988-4f7v-96qf) | Nested under the current `@voltagent/core@2.9.2` and `@voltagent/logger@2.0.2`; the root's independently managed OpenTelemetry graph resolves `2.10.0`. The VoltAgent package is at its published current version, and `npm audit` offers no compatible fix. | VoltAgent release notes and `npm audit --omit=dev --json` |
| `uuid@9.0.1` | [`GHSA-w5hq-g745-h8pq`](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | Nested only under the current `@voltagent/core@2.9.2`; a root override would cross the framework's private dependency boundary, and `npm audit` offers no compatible fix. | VoltAgent release notes and `npm audit --omit=dev --json` |
| `@ai-sdk/provider-utils@3.0.30` | [`GHSA-866g-f22w-33x8`](https://github.com/advisories/GHSA-866g-f22w-33x8) | The six propagated low records resolve through VoltAgent's nested AI SDK provider graph. A root override cannot safely replace that framework-private 3.x dependency; Station keeps the affected provider path behind authenticated runtime entrypoints and existing request-size limits. | VoltAgent and AI SDK release notes plus `npm audit --omit=dev --json` |
