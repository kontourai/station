# Code hygiene

Code that waits for a caller, compatibility code that must go away later, and
dated evidence all need an owner and an end. Without one, nobody can tell
paused work from abandoned work. This guide defines required source/test policies and the ownership markers
whose advisory reports identify unfinished work.

The ownership-marker reports below are implemented in `scripts/hygiene-report.mjs` and
`scripts/lib/hygiene/`. Each check derives its answer from the tracked tree,
the TypeScript syntax tree, or live GitHub issue state. None compares the
repository against a pinned list.

## Executable source and contract-test policies

Station pins the registry-published Veritas 1.12.1 package and Oxlint 1.88.0.
The public `@kontourai/veritas/hygiene/oxlint` plugin is configured by
`config/code-hygiene.oxlint.json`; the `code-hygiene` Repo Standard selects its
`npm run lint:hygiene` Evidence Check. That check is required in readiness,
including the existing hosted readiness lane. It checks source, tests, packages,
scripts and examples for unexplained Biome, ESLint, Oxlint and TypeScript
suppressions. Obsolete ESLint directives should be removed; live suppressions must explain the reason.
An explanation is reviewer context, not an authorized policy exception.

Pure contract tests under `packages/contracts/src/**/*.test.ts` additionally
reject direct real clocks, zero-argument `new Date()` and timer waits. Use fixed
fixtures or caller-supplied time. Integration, performance and lifecycle tests
outside that scope retain real timing where their behavior requires it. The
syntax rule is not complete alias/wrapper analysis. Existing behavioral tests
still establish correctness.

`npm run lint:hygiene:comments` adds advisory comment findings. It is not a
required gate: comment heuristics need human judgment and this adoption does not
bulk-delete rationale or baselines. Node namespace-import style is not enabled.

Preview before editing with `npm run veritas:plan -- <paths...>`. This delegates
to the published `veritas plan` CLI and returns guidance and check selection
without executing checks. `gate:for` consumes the same native `ChangePlan` for
Veritas guidance and retains Station's own pre-push and documentation selectors.

## Resource standards migration

The reviewed `.veritas/repo-standards/default.repo-standards.json` now uses
`apiVersion: veritas.kontour.ai/v1alpha1`, `kind: RepoStandards`, `metadata.name`
and `spec.requirements`. Existing requirement IDs, levels, evidence bindings and
assertions are preserved; consumers read through Veritas's public
`loadRepoStandards`, not a second local envelope parser. Repo Map and durable
readiness output formats remain unchanged. Migrating protected policy requires
a fresh policy-change attestation; a loader's compatibility support does not
supply approval.

The adoption tests execute the installed detector and real Station configuration
against known-bad and benign source. Full-check qualification, a clean committed
baseline, injected failure and byte-exact restoration are recorded separately;
a source test does not establish native/device or Nightly qualification.

## Mark unfinished work

Code that is intentionally present without a production caller, and is owned
by an open issue, carries a one-line comment at the symbol or in the file
header:

```ts
// UNWIRED(#1234): the scheduler calls this once queue leases land.
export function drainLeasedQueue() {}
```

Compatibility or migration code that must be removed later says when:

```ts
/** SUNSET(#1234): delete after every home has migrated past schema 12. */
export function readLegacyStore() {}
```

`TODO(#1234): <what remains>` stays valid for smaller follow-ups. Dated
`TODO(YYYY-MM-DD)` comments belong to the separate dated TODO sweep.

Rules:

- Cite one issue in this repository: `(#1234)`. An archive issue is closed
  history; re-file the work and cite the new issue.
- Follow `UNWIRED` and `SUNSET` with a colon and the missing piece.
- When the owning issue closes, wire the code or delete it. If the work moved,
  cite the issue that now owns it.
- A `STATION_FEATURES` flag is temporary by definition. Put a `SUNSET(#N):`
  comment above the statement that reads it, or in the docblock of the
  function that does.

Closing a slice or epic therefore includes removing or wiring every marker
that cites it, and updating the status of its design document. The pull
request template asks for this.

## What each check reports

Run every check with `npm run hygiene:report`, or one with its own script.

| Script | Reports | Derived from |
| --- | --- | --- |
| `npm run hygiene:markers` | Markers whose issue is closed, markers citing a missing number or a pull request, malformed markers, and `STATION_FEATURES` flags without an adjacent `SUNSET` marker. | Comments and Markdown prose in tracked files (fixtures excluded); issue state from GitHub in batched GraphQL requests; flags from the syntax tree of `src-server` code that reads `STATION_FEATURES`. |
| `npm run hygiene:issue-refs` | Bare `#N`, `station#N`, `kontourai/station#N` and issue URLs whose number is above the highest issue or pull request number in this repository. | Comments and Markdown prose; one GitHub request for the highest number. |
| `npm run hygiene:plan-labels` | Private plan identifiers, `--plan.md` file names, wave, track and review-round labels, delta-review labels, and severity tags such as `MED-4`. | Comments and Markdown prose outside tests and fixtures. |
| `npm run hygiene:module-ownership` | Directories under `src-server/services/` and `packages/` that are named neither in the [module map](../architecture/module-map.md) nor by their own `README.md`. | The tracked tree and the module map text. |
| `npm run hygiene:design-status` | Design and plan documents with no status line, an open status (proposed, draft, active, blocked, in progress) whose cited issues are all closed, or an open status that cites no issue in this repository. | `docs/design/*.md` and `docs/plans/*.md` banners; issue state from GitHub. |
| `npm run hygiene:evidence-retention` | Dated evidence directories without a retention line, and retention dates that have passed. | Directories under `docs/reviews/`, `docs/strategy/onboarding-*`, `docs/strategy/dogfood`, `docs/strategy/catches`, and any directory named `*-YYYYMMDD`. |

What counts as text: comments in code (strings are skipped) and Markdown
prose. Fenced code blocks and inline code spans are skipped, so a documented
example of a pattern is not reported as an instance of it. Release records
(`CHANGELOG.md` and `docs/reference/deploy-ledger.md`) quote titles as they
were written and are not scanned for issue references or labels. Dated
records under `docs/reviews/`, `docs/strategy/`, `docs/adr/` and
`.changeset/` keep their original labels.

The comment scanner is not a parser. It handles Rust character literals and
lifetimes, apostrophes inside YAML plain scalars, and YAML block scalars: the
content of a `run:` or `script:` block is read as a shell script, and other
block scalars are prose and are not scanned. A block scalar ends at the first
non-empty line indented less than its content, a comment line included, and
its key may be quoted. A keyless sequence entry (`- |`) counts its
indentation from the dash, a keyed one from the key. A JavaScript regular-expression
literal that contains a quote can still hide the rest of its line. A Markdown file that discusses the markers must put its examples in
code spans or fences.

There is no declared flag registry: Station reads `STATION_FEATURES` and
tests it for literal flag names. The markers check follows every read to its
membership tests: on the read itself, through a `const` list, or through an
unexported function that returns the list. A read in any other shape
(destructuring `process.env` under any key spelling, aliasing the list,
passing it on, exporting the list or the list function) makes the check
NOT_VERIFIED, naming the line, rather than reporting fewer flags.

### Evidence retention lines

Each dated evidence directory has a `README.md` with one of these lines,
exactly:

```text
Retention: until 2027-04-30
Retention: permanent — promotion evidence for the proof-family workflow
```

When the date passes, delete the directory, or extend the date and say why.

## Resolve a report

- Closed marker issue: wire the code to its caller, delete the code, or cite
  the open issue that now owns the remaining work.
- Missing number or pull request: cite the issue that owns the work.
- Flag without a sunset: add `SUNSET(#N):` naming the issue that removes the
  flag. A flag that is permanent should become a setting instead.
- Issue reference above the highest number: it is a pre-reset number or
  another repository's. Write `archive#N` (the report names the re-filed
  number when [the cutover map](../migration/issue-number-map.json) has one)
  or `owner/repo#N`.
- Plan or review label: rewrite the comment as the constraint the label
  stood for, with the issue that owns it. See
  [Maintain comments with their code](documentation.md#maintain-comments-with-their-code).
- Unowned module: add the directory to the module map, or add a short
  `README.md` that names its owner and purpose.
- Design status: update the banner to what shipped, or cite the open issue
  that tracks the remaining work.

## Exit status and NOT_VERIFIED

The checks are advisory. `npm run hygiene:report` exits 0 when every check
ran, whatever it found. It exits 2 when a check could not reach its data (no
`gh`, no token, no network, no module map) and prints `NOT_VERIFIED` with the
reason. Findings that need no GitHub data are still printed. A check that
could not run is never reported as clean.

`--json` prints machine-readable results. `--root <dir>` checks another
checkout. `--repo owner/name` resolves issues in another repository.
`--today YYYY-MM-DD` fixes the date retention is measured against. `--strict`
exits 1 when anything is reported; it exists for promotion.

## Nightly sweep

The `hygiene` job of
[the nightly sweep](../../.github/workflows/docs-freshness-sweep.yml) runs
`npm run hygiene:report` on `main` with read-only permissions, and the
`hygiene-issue` job keeps one `Code hygiene sweep` tracking issue current,
using the same single-issue pattern as the documentation freshness sweep. The
issue stays open while anything is reported or NOT_VERIFIED and closes when
nothing is. A NOT_VERIFIED run also fails the `hygiene` job. Neither job is a
required check.

## Promote a check

A check moves from advisory toward blocking only through the
[proof-family promotion workflow](../strategy/veritas/proof-family-promotion-workflow.md):
an owner, recent catch evidence, low false-positive risk, a review trigger,
and a reason ordinary tests do not already cover the failure. Record catches
from the nightly issue as that evidence. A promoted check runs with
`--strict`, which fails only on findings; NOT_VERIFIED already fails.

## Component and style ownership

Standard shell actions use `components/Button`, a re-export of the SDK's
`action-control` entry. The SDK's public `Button` retains its API defaults over
that same control. Notice cards use `NoticeAction` for their compact chrome;
feature owners retain callbacks, pending state and authority checks. Use
`Dialog` for standard dialog chrome and `ConfirmModal` for a confirmation.
`ResponsiveDialogSurface` remains the lower-level behavior/geometry primitive
for surfaces that deliberately own custom chrome. Inline disclosures and
composite widget controls are separate interaction patterns.

Shared token definitions come from `@kontourai/ui`. Legacy Station spacing
names are compatibility aliases mapped by value, not by suffix: old
`--space-1` remains 2px while `--k-space-1` is 4px. New and migrated styles use
canonical tokens; do not mechanically rename numbered tokens. Shared compact
hit-target geometry lives in `styles/control-recipes.css`, with existing
selector specificity preserved. Input hiding, responsive-only targets and
feature-specific geometry are not blanket utility conversions.

`npm run lint:component-style` scans shipped shell, SDK and pane-package TSX
and CSS, including untracked non-ignored source. Its baseline names each
inherited file/signature: new legacy-token references, standard-action
native-button recipes, native `dialog`/`alertdialog` shells and `role="alert"`
elements that hold their own button (use `ErrorState`) fail. Native switches, menu triggers, ordinary
geometry and literal code examples are not rejected solely for using native
elements. A passing scan is not rendered-layout, accessibility or behavioral
proof. Existing Fallow clone findings remain advisory candidates requiring
source review; repeated small layout declarations are not automatically defects.

The baseline records inherited migration debt, not permission to add more.
Reduce matching entries when consolidating an owner. New exceptions need owner
review and a specific reason. Check both themes, narrow layouts, keyboard focus,
44px hit targets, pending/error states and the actual consumer behavior before
removing replaced styles. Do not merge authority, cancellation or retry state
machines simply because their UI looks similar.

The consolidation audit found parallel shell/SDK button implementations,
identical notice-action recipes in attention and notification styles, dialog
consumers rebuilding shared chrome, repeated hit-target/hidden-text recipes,
and duplicated elapsed/word-count helpers. These grew across separate owners;
the existing broad ceilings allowed inherited patterns to be copied while
remaining green. The shared owners above replace those concrete copies.

The remaining migration is incremental: migrate an inherited signature with
its affected consumer, shrink its baseline entry, and verify rendered behavior.
Do not merge all repeated CSS into a generic component: responsive scope,
input semantics and domain authority can require separate owners. UI core owns
the new guard; revisit its signatures when the action/dialog contracts change
or a false positive appears. Ordinary behavior tests cannot detect a new,
visually equivalent copy of a recipe, which is why the syntactic guard runs
alongside them. Injected legacy-token/action/dialog violations must fail the
real command, and canonical controls and literal examples must remain green
before changing its required coverage.
