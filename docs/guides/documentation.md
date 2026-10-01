# Maintaining documentation

Use the [documentation map](../README.md) to find the document that owns a
topic before creating another one. Update that owner with the behavior change.

## Choose a location

| Material | Location | Purpose |
| --- | --- | --- |
| Product introduction | Root README | Product purpose and first steps |
| End-user task | `docs/user/` | Prerequisites and steps to complete a task |
| Contributor or operator task | `docs/guides/` | Setup, implementation, operation, and verification |
| Contract details | `docs/reference/` | Inputs, outputs, defaults, and errors |
| Module ownership | `docs/architecture/` | Interfaces, composition, and source routing |
| Proposal or decision | `docs/design/` or `docs/adr/` | Alternatives, rationale, and decision status |
| Execution plan | `docs/plans/` | Implementation sequence for an issue |
| Runnable example | `examples/` | Buildable extension with explicit prerequisites |

Use lowercase, hyphen-separated names for new prose files. Keep established
entry-point names such as `README.md`, `AGENTS.md`, and `CONTEXT.md`, and the
numbered ADR convention. Prefer topic names over `new`, `final`, or bare issue
numbers. Link new guides from the documentation map or their owning guide.

## Make authority explicit

Link important claims to their owning code, schema, or generated reference.
Proposals and historical records should declare their status near the top and
name the current owner or successor. Query GitHub for live issue, release, and
delivery state instead of copying status tables into operating guides.

For a behavioral explanation, follow the actual entry point and caller into
the implementation and its tests. Record what the evidence establishes:
source inspection, an executed test, a real provider/device journey, or an
observed release. A link to an existing source file proves location, not the
claim beside it. Mark missing evidence explicitly.

Inspect pinned dependency defaults when they affect a claim. A mocked factory
call does not prove what that dependency ultimately emits or persists.

The learning reader's [review ledger](../learn/review-ledger/) records
document purpose separately from source review. A source-reviewed record needs
the checked claims, code owners, executed checks, and limits. Append-only notes record which inputs a reviewer checked; Git history makes
later unreviewed changes visible. Neither a note nor a passing gate proves
accuracy. Revisit the affected claims before recording a new review. Never
mark a file reviewed merely because it appears in the inventory or has valid
links. Historical evidence and policy goals keep their own classifications.

## Find affected documentation and catch up

The pre-edit `npm run gate:for -- <paths...>` route includes a documentation
impact report. It follows the source dependencies recorded by previous claim
reviews, including document-to-document dependencies, and names related shipped
MCP topics. This is a list of places to inspect, not an instruction to rewrite
every selected page.

Use the same report directly:

```sh
npm run docs:impact -- src-server/path/to/changed-file.ts
npm run docs:impact -- --base=origin/main --json
npm run docs:impact -- --catch-up --json
```

With no explicit paths, it includes branch commits, staged and unstaged changes,
untracked files, and both sides of renames. It reads dependency records from
the comparison baseline, intervening committed ledger revisions, and the
working tree, so removing a source link
does not silently erase the old review lead. An unreadable base or malformed
input fails the report rather than returning an empty impact list.

Catch-up derives outstanding reviews from Git history since the ledger's
`coverageBaseline`. Each first-parent landing commit that changes a document
or a cited source needs an added note covering that document and input. Squash
commits contain both source changes and notes. Ordinary merges introduce the
other branch's notes with its source changes. A later deliberate catch-up note
can cover named outstanding inputs; restoring old bytes alone cannot erase an
unreviewed change. `docs:review:record -- --show-delta` shows the input diff
since the coverage baseline, including working edits. This is an inspection
lead, not an assertion that every intermediate change is visible in the net diff.

`--base=<ref>` overrides the catch-up search for new or unmapped paths, but does
not change the freshness baseline. The one-time path-only migration sets the
baseline to its pre-migration HEAD and grandfathers existing decisions; it does
not establish a new semantic review. Do not advance it just to hide gaps.
Both modes report files with no known documentation dependency. Trace those
through actual callers, add missing source relationships, or give a concrete
no-documentation-impact reason in the PR. Shallow or unavailable history is
reported explicitly; fetch full history before judging accumulated freshness.

The map records reviewed relationships. It does not discover every code import,
runtime call, dependency default or business requirement. Broad owners such as
the module map can select many topics. Periodic audits still need to look for
missing relationships. Run `docs:truth:gate` after reviewing and updating the
ledger; the impact report does not change evidence or grant approval.

Veritas selects this command as required `documentation-truth` evidence,
including for source-only changes. A stale recorded review that the change
touched blocks readiness (see [keep reviews fresh](#keep-reviews-fresh));
unmapped dependencies and prose accuracy still require review. The
[activation record](../../.veritas/init-plans/documentation-maintenance.md)
retains the owner approval and failure/restoration controls.

## Keep reviews fresh

A pull request adds human review notes, not derived hashes or source revisions.
The policy in
[`documentation-freshness.mjs`](../../scripts/lib/documentation-freshness.mjs)
serves `docs:truth:gate`, Veritas readiness, `docs:learn:check`, captures and
`docs:freshness:check`. The mode follows the event, not the command:

- **Scoped** (local runs, pre-push, `pull_request` and `pull_request_target`):
  every document whose file or listed sources the PR's diff against its merge
  base touches needs a new note covering those inputs. Human record edits also
  need a note. Dependencies at the merge base and in the working tree are both
  considered, so dropping a citation cannot hide a changed input. A removed
  record whose document remains cannot hide source changes either. Notes
  already on the base branch do not qualify as this PR's review. A later edit
  on the PR needs another review; another PR landing on the base branch never
  invalidates its notes.
  The base resolution order remains `STATION_DOCS_FRESHNESS_BASE`, then
  `STATION_CI_FAST_BASE`, then `origin/main`. An unavailable base falls back to
  strict checking. Fetch before checking so the comparison uses current refs.
- **Advisory** (other GitHub Actions events, including the merge queue, main
  pushes, Nightly and manual runs): outstanding reviews are reported, never
  failed. One-commit shallow checkouts report unavailable history instead of
  judging it, including when scoped mode was requested.
- **Strict** (`STATION_DOCS_FRESHNESS=strict`): all known outstanding reviews
  block. Shallow or unavailable history remains explicitly unjudged.

After inspecting the changed claims and their callers:

```sh
npm run docs:review:record -- --show-delta docs/guides/example.md
npm run docs:review:record -- docs/guides/example.md --note "Checked the new retry limit against its caller."
npm run docs:review:record -- docs/guides/example.md --note "..." --drop-source src-server/removed.ts --add-source src-server/new-owner.ts
npm run docs:review:record -- --batch reviews.json
npm run docs:freshness:check
```

Batch input is `[{ "path", "note", "removedSources"?, "addedSources"? }]`.
Commit the reviewed document and source changes first, then record and commit
the note. The note records the context HEAD and the inputs inspected; the
context revision does not have to survive a squash merge. Recording writes
only a new uniquely named notes file, plus a record edit if the dependency list
really changes. It refuses empty notes, unknown paths, invalid or duplicate
sources, uncommitted reviewed inputs, and captures whose image identity changed.
It validates the entire batch before writing. New records still need their
kind, state, summary and limits decided by a reviewer. A deliberate review of
unchanged inputs is allowed (`--rereview` remains accepted for compatibility).
`--verify-bindings` applies only to legacy digest records; path-only records
have no bindings to verify.

A cited JSON value can still use a JSON Pointer, for example
`package.json#/scripts/docs:truth:gate`. Git comparisons compute the value's
change at runtime; unrelated committed manifest edits do not require a review
of that value. No value digest is stored in a record. Other formats use whole
file paths. Notes document review decisions, not automated semantic approval.

### Ledger layout and merges

GitHub uses Git's default text merge; this layout needs no local merge driver.

| Path | Contents |
| --- | --- |
| `ledger.json` | Layout version 3 and the history `coverageBaseline` |
| `records/<document>.json` | Path, kind, state, summary, limits, source path list and retained historical checks |
| `captures/<capture>.json` | Source path list and retained historical review notes; image identity stays in `media.json` |
| `notes/<time>-<hash>.json` | Context revision and reviews: document/capture path, note text and covered inputs |

Each source path occupies its own line, separated from the next by a blank
line. Ordinary source reviews leave all record and capture files untouched.
Two PRs can review different edits to the same source and add distinct notes
files; neither rewrites shared derived data. Real concurrent edits to the same
human decision or additions at the same place in a dependency list can still
conflict and need a human resolution. The loader requires canonical bytes and
rejects edited notes or unexpected files. All consumers use
[`review-ledger-store.mjs`](../../scripts/lib/review-ledger-store.mjs), including
impact/catch-up, the learning reader and knowledge graph. Legacy digest layouts
remain readable from history.

The deterministic one-time migration is:

```sh
node scripts/migrate-review-ledger.mjs --path-only
```

It drops document/source bindings in place, keeps human decisions and notes,
and sets the baseline to the existing HEAD. Rerunning it preserves the baseline
and bytes. An older branch that rewrote binding lines may get text conflicts
when it merges main. While that merge is in progress, run the same command;
it folds Git's three index stages after discarding bindings and preserves
independent source-list edits. Then stage `docs/learn/review-ledger` and finish
the merge. It stops and names genuinely conflicting human fields; it never
picks a source digest as a resolution. Notes recorded by that old branch are
carried into new notes with explicit input coverage. No fresh review of merged
source bytes is required merely because main moved.

For the older single-file layout, use
`node scripts/migrate-review-ledger.mjs --base "$(git merge-base HEAD MERGE_HEAD)"`
first to fold that file and capture metadata, then run `--path-only`.

Nightly's [freshness sweep](../../.github/workflows/docs-freshness-sweep.yml)
tracks outstanding reviews on main in one issue. It never fails a required
check. Land broad semantic audits in subsystem slices to keep review scope
manageable; passing a note-coverage gate does not certify prose accuracy.

## Generated release records and removed notes

Automatic release bookkeeping must not masquerade as a new human review. The
review compiler recognizes one named generated-output contract: the deploy
ledger. It validates the current JSON entries, rejects duplicate release
identities, and requires the exact Markdown projection for this repository.
The generator and validator owners must have no outstanding input review gaps. Current
output receives a separate generated-validation status; the human review decisions remain intact. This validates data shape and rendering,
not publication outcomes, history completeness, artifact availability or platform
behavior.

A purpose-classified release-note file under `.changeset/` may become absent
without invalidating the retained classification. It must have no behavioral
source/check claims; absence does not prove that a release consumed it. The
README, current guides, malformed records and missing behavioral dependencies
are still errors. Catch-up reporting keeps these lifecycle states separate from
claims that need source review. New generated owners need their own reviewed
contract and refusal tests; `kind: generated` alone never exempts a file.

## Make the application learnable

The reading path is product purpose → system overview → subsystem or user
journey → public contract → implementation and evidence. Keep the root README
short and route readers into that path. Package and example READMEs explain
their purpose, prerequisites, supported usage, boundaries, and next reading.
Instruction files route work rather than duplicating the guides.

For each subsystem, explain the problem it solves, how it connects to other
parts, who owns state and authorization, and what happens on success and
failure. Cover cancellation, recovery, persistence, and platform differences
where they affect the journey. Link design tradeoffs and known limitations so
a reader can propose an improvement with enough context to judge it.

Use interactive navigation to reveal detail without hiding essential claims:
search by concept, follow a journey in order, open source and tests, and link
to a specific section. Keep ordinary Markdown readable without JavaScript.
An interactive map should consume canonical content rather than maintain a
second account of the architecture.

Diagrams name their scope and use the same vocabulary as the prose. Check each
edge against a real caller, event subscription, or storage operation; distinguish
these kinds of flow and label optional or planned paths. Put a source/evidence
route beside the diagram. Verify the rendering, labels, and narrow-screen
reading order; valid Mermaid syntax alone is not a readability check.

## Turn findings into maintained improvements

Describe current behavior in the canonical guide, including limits that affect
the reader. Track proposed fixes in GitHub. Search both open and closed issues
before filing: a closed issue may have been folded into an active epic without
being implemented. Check its disposition and current code before treating it
as resolved or creating a duplicate.

An actionable finding names the observed behavior, a source revision, the
affected caller, evidence and its limits, a suggested approach, and acceptance
cases. Distinguish a demonstrated defect from an architectural recommendation.
Include the exact documentation owners the implementation must revisit: guides,
READMEs, diagrams, examples, and shared learning/MCP inputs where affected.
Issue creation follows the task's authorization and the repository's disclosure
policy; the audit skill does not itself authorize external writes.

The audit keeps evidence and issue links, not a competing status board. When
the fix ships, update current explanations and remove or replace the resolved
limitation in the same PR. Regenerate derived content and re-review affected
ledger claims against the changed implementation. Preserve dated audit findings
as history, linked to the fix; closing an issue alone does not verify new prose.

## Edit for clear language

After checking technical accuracy, make a separate editorial pass through the
overview, detailed guides, READMEs, navigation labels, diagram text, and MCP
topics. Write for someone learning Station: explain what a part does before
introducing its implementation terms, then link to the detail.

Use concrete subjects and verbs. Remove promotional claims, stock transitions,
repeated summaries, and words that add no meaning. Replace vague descriptions
such as “provides robust lifecycle management” with the specific operations
and limits verified in the code. Explain necessary jargon on first use; keep
established domain names consistent with the glossary and UI.

Shorter prose must retain conditions, defaults, units, ownership, failure cases,
platform differences, and reasons for past fixes. Do not turn “may” into “will,”
drop an exception, or generalize a test result while simplifying a sentence.
Keep exact API names, commands, paths, and source/test references. For example,
“runtime retrieval remains credential-free” can become “reading these topics
does not require credentials”; the separate restriction on filesystem and
network access still needs its own explanation.

Edit canonical inputs and regenerate derived pages and MCP content. Preserve
dated records, quoted evidence, legal text, directives, and fixture text when
their exact wording matters. Review the final diff for changed meaning and
read the rendered result in order; automated checks cannot judge whether an
explanation is clear or faithful to the code.

## Maintain comments with their code

Prefer clear names, types, and small functions over comments that narrate the
next statement. Remove redundant narration and correct stale behavior claims.
Keep concise explanations of non-obvious invariants, ownership, ordering,
security boundaries, external compatibility constraints, and previous defects.
These explain why an apparently simpler change would be wrong.

Long rationale belongs in a canonical guide or ADR, with a short local pointer
when the decision is easy to accidentally undo. Preserve regression-test and
issue references when moving it. Tests should encode the reproducible failure;
they do not always replace the explanation of why it matters.

Do not remove licenses, public API documentation, compiler/linter directives,
generated markers, or unresolved TODO obligations as prose cleanup. Deliberately
malformed comments in fixtures are test inputs. Review comments in context,
never with a bulk stripping regex or a target deletion percentage. Keep comment
cleanup behavior-neutral and validate it separately from functional changes.

The repository [documentation-audit skill](../../.agents/skills/documentation-audit/SKILL.md)
applies this workflow to feature changes and full audits. Its
[audit plan](../plans/documentation-code-audit.md) retains the complete scope,
including Markdown outside `docs/` and historical material.

Keep generated blocks under their existing generator. For example,
`npm run docs:index` generates the design and plan indexes. Edit generator
inputs, regenerate, and review the output.

All tracked repository content is public, including documents omitted from
Pages. Use generic hostnames and paths. Keep private research, credentials,
customer data, and machine-specific operational logs outside the repository.
See [Contributing](../../CONTRIBUTING.md) for disclosure guidance.

## Document reusable integrations as they ship

For deployment, storage adapters, authentication, execution, and integration
changes, document the external company or project journey in the same PR. Use
[Integrating Station](integrating-station.md) for the delivery expectations:
prerequisites, runnable example or template, public contract, operating lifecycle,
and evidence. Keep generic domains and paths, state provider-specific dependencies,
and record unverified steps. Distinguish the self-operated path from managed
service conveniences without promising undelivered features or service levels.
The PR documentation-impact entry should link the affected guide/example or
explain concretely why that change does not affect the integration journey.

## Retire or move a document

1. Search incoming links and tooling references with `rg` before moving or
   deleting a file. Paths can be contracts for scripts as well as readers.
2. Keep historical rationale when it remains useful, with a status banner and
   successor link. Do not rewrite a dated assessment to imply current evidence.
3. Remove duplicate instructions in favor of the canonical guide. Preserve a
   forwarding page for a published path when practical.
4. Update navigation and generated indexes in the same change. Stage new files
   before checking: several checks use `git ls-files`.

## Verify the change

Start with `npm run gate:for -- <changed-paths...>` and the
[testing guide](testing.md). Existing documentation checks are:

```bash
npm run docs:truth:gate
npm run docs:reference:gate
npm run docs:pages:build
npm run docs:learn:check
npm run docs:mcp:check
```

`npm run docs:links:check` checks tracked Markdown links using the learning
reader's parser and rendered heading IDs. It checks relative and self links,
including section anchors, and GitHub `main` or exact-current-revision links
that the reader opens locally. Historical revision links remain external;
this check does not crawl external sites. Fenced and inline code examples are
not links. Duplicate headings receive unique suffixes. For a stable explicit
anchor, the reader accepts an empty `<a id="stable-name"></a>` or
`<span id="stable-name"></span>` with a safe ID; arbitrary raw HTML stays escaped.
The learning generator runs the same validation against the captured document
bytes before producing a snapshot.

These check links, indexes, public content policy, examples, source paths,
documentation tests, and generated Pages output. They do not prove every prose
claim or deployment. Inspect changed instructions against source and report
runtime steps not exercised. New Pages content must be explicitly admitted in
`docs/pages/public-docs.json`; creating a guide does not publish it there.

The learning atlas and Station Docs MCP share the concept catalog and module
map. The [shipped manual](../reference/station-docs.md) owns the MCP's introductory
and authoring topics. Run `npm run docs:mcp:generate` when those inputs change;
do not hand-edit `src-server/tools/station-docs-content.ts`. Keep generated
payloads static so documentation retrieval cannot acquire live-state access.
