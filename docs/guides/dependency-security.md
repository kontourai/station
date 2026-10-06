# Dependency security

Station uses one root `pnpm-lock.yaml` for its workspace. Root, SDK, and Shared
remain separate advisory views of that graph; they no longer own independent
npm lockfiles.

## Proxy, copy, and numeric formatter advisories (2026-10)

The workspace pins `proxy-addr` 2.0.8 and `fast-copy` 4.1.0. The
[proxy advisory](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) concerns a
remote caller spoofing `X-Forwarded-For` when a consumer configures a short
IPv4-mapped IPv6 trust subnet. Both Express dependency branches use the pin;
Station's trust configuration is unchanged. Version exposure does not prove
that Station uses the vulnerable trust configuration.

The [copy advisory](https://github.com/advisories/GHSA-jggr-w7fw-pc2j) concerns
stack exhaustion from deeply nested input. `pino-pretty`, used by Station's
logging seam, creates the copier with default options. The upstream patch
limits traversal to 1,000 nested objects and throws `MaxDepthExceededError`, a
`RangeError` subclass. This bounds traversal; it does not make arbitrary deep
input succeed or establish that an unauthenticated request reaches that call.

`sprintf-js` remains version 1.0.3 with a Station-owned
[package patch](../../patches/sprintf-js-1.0.3.patch), bound through
`patchedDependencies` and the lockfile hash. The
[formatter advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) concerns
attacker-controlled precision causing an uncaught numeric `RangeError`. The
patch covers both `src/sprintf.js` and the shipped `dist/sprintf.min.js`:
`e` and `f` precision is capped at 100; `g` precision is clamped to 1–100 on
Station's Node 24 runtime. Supported precision and omitted-precision behavior
stay unchanged. Unsupported precision now rounds at the bound; explicit
`g` precision zero uses one significant digit instead of throwing. This is a
compatibility choice for previously invalid input, not a new upstream version.
Width, padding, parser input size, and nonnumeric type errors are outside this
patch's scope. The Angular artifacts delegate to the formatter globals.

The dependency path is VoltAgent → gray-matter → js-yaml 3 → argparse 1 →
sprintf-js. Gray-matter uses js-yaml's library `safeLoad`/`safeDump` exports;
that library entrypoint does not import argparse. The bundled js-yaml CLI
does import argparse. Installed dependency reachability is broader than an
executed Station request path; this inspection does not prove remote format
control. Keep the legacy YAML API rather than forcing js-yaml 4, where those
calls no longer have the same contract.

The registry advisory scan may continue to report patched `sprintf-js` 1.0.3
by version. Patch application and bounded behavior evidence do not imply a
green advisory floor. At reviewed revision `2285053942`, controlled dependency
probes on Node 24.19.0 checked source and minified formatter code through CJS,
browser globals, and AMD. All 66 supported-output comparisons matched the
unpatched baseline. Numeric boundary and 400-digit precision probes confirmed
bounded rounding, including the explicit `g0` tradeoff; Angular wrapper
delegation and legacy YAML library/CLI controls passed. These are dependency
behavior observations, not production reachability or full browser/native
qualification.

The actual advisory scan at that revision remained red for high-severity
`source-map-js` and the version-reported, untracked production `sprintf-js`
1.0.3 advisory. The `proxy-addr` and `fast-copy` findings were absent. Production
closure means the package is in the installed dependency graph; it does not
prove an attacker can supply a format string to a Station request path. A
locally patched version still needs an explicit maintainer disposition before
the version-based floor can be considered resolved. No disposition is granted
by these probes or this guide. No advisory exception, residual, baseline, or trust
policy is changed by these repairs. The separate
[source-map advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) is not
addressed here. Remove the local formatter patch only after a compatible
upstream release passes the same numeric, formatter, YAML, and CLI controls.

## Lifecycle scripts are reviewed capabilities

Use `npm run dependencies:ci` for a frozen install and
`npm run dependencies:install` when intentionally updating dependencies. The
managed entry point bootstraps the exact pnpm version in `package.json`, forces
an inert install, and validates every installed lifecycle package's locked
identity and complete hook set before running approved commands. Keep npm for
script execution and publication; do not use raw npm to install this workspace.

`pnpm-workspace.yaml` owns workspace membership, overrides, pinned build
permissions, and native patches. The retained npm workspace list supports
existing `npm run --workspace` commands and is checked for parity. The hoisted
layout preserves existing native consumers. Clone-or-copy imports and a local
store layout prevent approved native writes from modifying another worktree;
on filesystems without copy-on-write clones, copying trades disk savings for
that isolation.

The runner verifies native artifacts, Station's Node contract, and Git hooks.
The VoltAgent patches are applied by pnpm from `patchedDependencies`; their content
hashes are bound to the lockfile. The Core 2.10.0 patch awaits ordinary input
persistence before starting the model, preventing a fast reply from preceding
its user's message in durable history. The real-framework regression in
`src-server/runtime/frameworks/__tests__/voltagent-memory-order.test.ts` holds
the first storage read and verifies model admission and persisted ordering.
Remove the patch only when that test passes against an upstream fix.
The lifecycle allowlist still owns the stronger
exact-hook and artifact proofs; a successful raw pnpm install is not their
receipt.

`npm run dependencies:check` fails on an unknown, nested-path, version,
integrity, lifecycle marker, platform, or stale-entry change. An entry's
`path` is the package directory relative to the checkout as the inventory
records it: `node_modules/<package>`, a nested
`node_modules/<parent>/node_modules/<package>`, or, when pnpm materializes a
copy under a workspace package, `<workspace importer>/node_modules/<package>`
where the importer is a directory listed under `importers` in
`pnpm-lock.yaml` (never `.`, never an arbitrary prefix). `npm run
dependencies:propose` emits a review starting point; it is not an approval.
Every approval names an owner, reason, artifact proof, purl, and dependency
refresh/removal/advisory trigger. The release SBOM context carries the exact
allowlist digest and purls. Windows native proof remains a platform receipt,
not something inferred from Linux or macOS.

```bash
npm run audit:policy
```

The command obtains one `pnpm audit --json` registry response and derives full
and production reachability from the lock. The root view combines all managed
workspace importers; SDK and Shared each use their own importer closure.
It preserves critical/high blocking and exact production residual policy.
Run locally it covers all three scopes. In CI, pull-request, push and
merge-queue runs cover the scopes whose dependency inputs the change touched
(see below); the scheduled scan always covers all three, which is what makes it
a backstop rather than a second copy of the same narrowing. It fails for every
critical or high advisory that is not fixed or exactly matched by a current
exception, and for every production moderate or low advisory that is not
exactly matched by a current residual record. It also fails for malformed,
expired, duplicate, severity-mismatched, or unused records. Blocking audit
records must resolve through an acyclic `via` graph to concrete advisory
identities, and the normalized blocking metadata counts must match the records. Audit
subprocess signals and operational exit statuses also fail closed.

The retained legacy npm audit runner records bounded phase diagnostics under
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
changing the audit outcome. The current root manifest selects the pnpm branch
in [`collectAudits`](../../scripts/dependency-advisory-policy.mjs), whose
[`runPnpmAudit`](../../scripts/lib/pnpm-advisory.mjs) uses bounded owned-process
capture and a 240-second deadline. It does not call the npm phase-diagnostics
adapter. Do not expect structured npm phase files from the normal pnpm audit
or interpret their absence as a completed phase.

## Local CodeQL SARIF policy

The hosted security-analysis workflow is a JavaScript/TypeScript source scan
with `security-extended` queries and no build. It skips test code only
(`**/__tests__/**`, `tests/**`, `**/*.test.*`, `**/*.spec.*`), through an
inline config the workflow gate pins, so a candidate cannot widen it. It writes the action's documented
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

The local policy rejects empty, malformed, truncated, rule-free, or failed
analysis evidence; it requires an identified CodeQL run, rule inventory,
valid rule references, result messages, and severity resolved from the result
or its referenced rule. Structural evidence failures and unbaselined error-level
results block. Exact error entries in `scripts/codeql-error-baseline.json` are
reported as baselined; warning/note results are advisory. A nonempty result list
therefore need not fail. Stale baseline entries fail on main pushes but warn on
PR/merge-group checks, which read the protected base baseline. The owner is
[`codeql-sarif-policy.mjs`](../../scripts/codeql-sarif-policy.mjs). A clean
completed scan may legitimately have an empty result list.

These checks validate the supplied evidence's structure and findings. A valid
local file is not proof that a trusted CodeQL execution produced it; the hosted
workflow separately owns capture and protected-base enforcement.

GitHub ingestion is **NOT_VERIFIED**. Rust analysis is also **NOT_VERIFIED**:
this foundation initializes only `javascript-typescript` and does not build or
analyze Rust. Do not infer coverage of native code, a hosted finding, or a
repository security-alert state from this workflow.

## Hosted dependency review

For pull requests and merge groups, the same base-controlled workflow also calls GitHub's
`actions/dependency-review-action` directly on a disposable `ubuntu-22.04`
runner. It has read-only contents permission, checks high and critical
dependency changes (`fail-on-severity: high`), disables license checks and
warn-only behavior, and never checks out or executes candidate code. It does
not use secrets, caches, artifacts, persistent runners, or PR comments.
Merge-group review supplies its explicit base/head SHAs; a PR uses the action's
PR context. Workflow presence and local tests do not establish a hosted result.

The capability is not assumed to be available merely because the workflow is
present: if GitHub dependency review is unavailable for the repository or its
plan, the dependency-review capability is **NOT_VERIFIED**. A missing or
unavailable capability is not a green dependency review, and this workflow
does not claim hosted advisory ingestion or GitHub alert state.

## Investigate a failure

Capture both the complete development graph and production reachability:

```bash
npm run audit:policy
```

This reports each selected view's full graph and production closure from
one registry snapshot. Registry advisory data changes over time; use the
executable report rather than copying historical totals into automation.

The full graph is never suppressed: its counts remain in the report even when
development-only moderate or low findings need no production residual record.
Production reachability is an additional exact-record requirement, not a broad
severity waiver.

Prefer the smallest compatible direct update. When a vulnerable transitive
version remains, add the narrowest compatible `overrides` entry that cannot
affect an unrelated dependency path. Update overrides in `pnpm-workspace.yaml`, then regenerate the workspace lock:

```bash
npm run dependencies:lock
npm run lockfile-sync:gate
npm run dependencies:ci
npm run audit:policy
```

The SDK and Shared resolve Station Contracts from the in-repo workspace.
Keep the public semver declarations for npm publication; pnpm's checked
workspace links select local source during development. Do not create an
independent lockfile inside a root-managed workspace.
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

Within 14 days of an `expires` date the policy prints a `WARN:` line naming
the record and the days remaining, and raises it as a GitHub warning
annotation on any Actions run that scans — the six-hourly scheduled run in
`.github/workflows/dependency-advisory.yml`, and any pull request or merge
group whose diff touches a dependency input. The reminder never changes the
exit code, so renew or remediate before the date rather than after the floor
starts failing.

That schedule is also the repository's own detector for a floor break nothing
in the repository caused. A newly disclosed advisory, or an affected range
narrowing until a residual record is unused, reds the floor for every
dependency-touching pull request from the moment the registry publishes it — with no commit to
attribute it to, and outside what the expiry warning above can see. The
scheduled run scans on its own cadence, and a failure files or updates one
tracking issue through `.github/workflows/main-health.yml`, titled
`Main pipeline red: Repo: Dependency advisory`. The next green
scheduled run closes it. Renew or remediate the ledger against that tracker
rather than against whichever pull request happened to gate next.

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
three. A change to the shared pnpm lock, workspace settings, or patches audits all
three views. A change to `packages/sdk/package.json` selects SDK; an
unattributable dependency input or failed classifier selects all scopes. The
scheduled scan always covers all scopes. A single registry request serves all
selected views, avoiding repeated registry-bound npm processes while retaining
each importer's exact full and production closure.

## 2026-09 grpc-js and DOMPurify floor

The workspace lock selects `@grpc/grpc-js@1.14.5` and `dompurify@3.4.16`.
These compatible patches address the [optional-client-certificate authentication
advisory](https://github.com/advisories/GHSA-m9gg-hp2v-232j),
[handler-error disclosure](https://github.com/advisories/GHSA-f596-whhp-79r4),
and [detached-subtree sanitizer handlers](https://github.com/advisories/GHSA-p98j-92pf-mc4p).
The threats are remote callers reaching certificate-based gRPC authentication
or failing handlers, and untrusted markup reaching in-place sanitization with
node-removing after-sanitize hooks.

Station's locked gRPC path belongs to the OpenTelemetry exporter client;
source review found no first-party gRPC server or `getAuthContext` caller.
The chat HTML renderer sanitizes strings with default options. Plugins receive
the shared sanitizer API and may supply configuration, so absence of first-party
in-place hooks does not qualify every plugin. These caller bounds are source
evidence, not a reproduced Station exploit.

The live advisory floor failed before these patches and passed afterward for
root, SDK and Shared. The real chat sanitizer and shared-plugin consumer tests
passed, as did SDK typechecking and the managed frozen install. Minimum release
age, lifecycle permissions, sanitizer configuration and existing residual
expiries remain unchanged; no new exception was added.

## 2026-09 Axios floor

The Station workspace override requires Axios 1.20.0 or newer compatible 1.x,
and its lockfile selects 1.20.0. This fixes the new high-severity advisory floor
that blocked the Agent SDK merge candidate. The existing advisory policy and
its accepted residuals are unchanged.

The threat models include an untrusted server returning a crafted redirect
under Node environment-proxy/NO_PROXY handling (availability), and existing
same-process prototype pollution changing form serialization or transport
options. Fully privileged malicious code can already control its process;
this update does not isolate it or grant new request authority. See the
[redirect advisory](https://github.com/advisories/GHSA-mghh-pgcx-3jjj) and
[form-options advisory](https://github.com/advisories/GHSA-x97p-jq2g-jp4f).

A network-free public `axios.toFormData` probe with an inherited `maxDepth: 1`
failed on 1.18.1 with `ERR_FORM_DATA_DEPTH_EXCEEDED`; 1.20.0 retained the clean
nested serialization. The live full/production audit views for root, SDK, and
Shared passed after the update. These are dependency-level evidence, not a
reproduced remote exploit against Station. Runtime Axios consumers include
transitive SAP HTTP clients, localtunnel, and PostHog; their configuration and
network reachability determine which advisory conditions apply.

## 2026-09 gRPC floor

The workspace override requires `@grpc/grpc-js` 1.14.5 or newer compatible
1.x, and its lockfile selects 1.14.5. The
[certificate-authentication advisory](https://github.com/advisories/GHSA-m9gg-hp2v-232j)
identifies 1.14.5 as patched on the 1.14 line.

The threat is an unauthorized client certificate being exposed as authorized
when a gRPC server permits optional client certificates and uses `getAuthContext`
for authentication. Station's own server code does not call `getAuthContext`;
its installed dependency path is the OTLP gRPC exporter. This correction is
bounded by version and source inspection, not a reproduced remote certificate
attack against Station. It changes no Station authentication contract or
advisory-policy exception.

## 2026-09 DOMPurify floor

The root dependency and lockfile select DOMPurify 3.4.16, fixing the
[in-place hook-detachment advisory](https://github.com/advisories/GHSA-p98j-92pf-mc4p).
Its threat model is untrusted markup processed in `IN_PLACE` mode with a
node-removing after-sanitize hook. Station's first-party HTML renderer uses
string sanitization without those options or hooks; the plug-in bridge exposes
the underlying sanitizer API. No matching first-party caller was found.

An isolated jsdom probe retained a descendant `onerror` attribute after hook
detachment on 3.4.15, while 3.4.16 removed it. That proves the library-level
neutralization difference; it does not execute an attacker script or establish
an exploitable Station path. The live advisory floor passed after the gRPC and
DOMPurify corrections without new exceptions.

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

This section preserves the **2026-08-08 npm intake**, including then-current
versions, controls and recheck date. It is not today's pnpm graph, advisory
inventory or active exception approval. Use the current policy output and
exception file for current disposition.

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
