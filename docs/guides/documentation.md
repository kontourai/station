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
the checked claims, code owners, executed checks, and limits. Its document and
source hashes make later changes visible; they are not evidence of accuracy by
themselves. Revisit the affected claims before refreshing a stale record. Never
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

Catch-up compares the recorded document and source hashes with current bytes.
For each stale review it lists the changed inputs, the revision at which each
was reviewed, and the last commit that edited the page. A page's edit commit is not proof
that someone reviewed its supporting code. Use the recorded revision and changed
paths to inspect the relevant Git diff (`docs:review:record -- --show-delta`
prints it); the hashes identify the exact bytes previously reviewed.
Unchanged records do not need another whole-application review.

The ledger's `coverageBaseline` is the starting revision for searching new or
unmapped changes during catch-up; `--base=<ref>` overrides that search. It is
separate from each page's review revision. Advance it only after accounting for
its outstanding coverage, never just to shorten a report. A missing baseline
requires an explicit ref. Both modes report files with no known documentation
dependency. Trace those through actual callers, add missing source relationships,
or give a concrete no-documentation-impact reason in the PR.

Historical dependency collection accepts a semantically valid record whose
JSON layout was reformatted in an intermediate commit. It retains that record's
source links rather than dropping them. This tolerance belongs only to the
advisory impact report: current records, default historical reads, capture
reviews and append-only note hashes still require their canonical bytes.
Malformed JSON, unknown fields, misplaced records and invalid source bindings
remain errors. Collecting an old dependency never approves a current claim or
refreshes a review hash.

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

Staleness is caught once, in the pull request that caused it. One decision in
[`documentation-freshness.mjs`](../../scripts/lib/documentation-freshness.mjs)
serves every consumer: the ledger test in `docs:truth:gate` (and so Veritas
readiness, pre-push and `ci:fast`), `docs:learn:check`, the capture check and
`npm run docs:freshness:check`. The mode follows where the check runs, not
which command runs it: `ci:fast` is scoped on a pull request and advisory in
the merge queue.

- **Scoped** (outside GitHub Actions, such as local runs and pre-push, and in
  `pull_request` or `pull_request_target` workflows): a stale review or capture
  blocks when this change's own diff against its merge base touches its
  document, capture or a recorded source, including deleting it, or edits its
  record, capture metadata or capture review. Other stale entries are printed as advisory.
  The base is `STATION_DOCS_FRESHNESS_BASE`, then `STATION_CI_FAST_BASE` (the
  PR check sets it to the pull request base), then `origin/main`. If the scope
  cannot be computed, every stale entry blocks. The non-required fork-smoke job
  can hit that fallback when its checkout lacks the upstream base commit.
- **Advisory** (every other GitHub Actions event: the merge queue, pushes to
  `main`, Nightly and manual runs): stale entries, including records whose
  document or source another change removed, are reported and never fail. A
  queue candidate contains other pull requests' changes, and each pull request
  already passed the scoped check on its own head, so another PR's change
  cannot dequeue yours. The repository-scan job also reports rather than
  judges: its one-commit checkout cannot compute a pull request's scope.
- **Strict**: every stale entry blocks. Set `STATION_DOCS_FRESHNESS=strict` to
  audit the whole ledger locally.

A long branch therefore does not re-review records after merging `main`: only
entries its own changes touch are in scope. Fetch before checking, because an
old `origin/main` makes the scope larger, not smaller.

After reviewing the changed claims, record the review instead of editing hashes:

```sh
npm run docs:review:record -- --show-delta docs/guides/example.md   # git diff <reviewed revision> HEAD -- <changed inputs>
npm run docs:review:record -- docs/guides/example.md --note "Checked the new retry limit against its caller."
npm run docs:review:record -- docs/guides/example.md --note "..." --drop-source src-server/removed.ts --add-source src-server/new-owner.ts
npm run docs:review:record -- docs/guides/example.md --note "..." --rereview   # a new review of unchanged bytes
npm run docs:review:record -- --batch reviews.json   # [{ "path", "note", "removedSources"?, "addedSources"?, "rereview"? }]
npm run docs:review:record -- --verify-bindings      # revisions that do not contain their recorded bytes
npm run docs:review:record -- docs/guides/example.md --note "..." --drop-source package.json --add-source 'package.json#/scripts/docs:truth:gate'
```

Commit the reviewed document and source changes first. The command binds each
changed document or source to the last commit that set it to its current bytes,
so `--show-delta` can later show exactly what changed since the review. It
refuses bytes that are not committed yet. It recomputes only the changed
hashes, leaves every other line alone, and adds the notes as one new notes
file. A capture path under `docs/learn/media/` refreshes the capture's source
bindings and notes, but never its capture identity in `media.json`. The command
refuses:

- an empty note, an unknown path or an unresolvable `HEAD`;
- an untracked or duplicate source, and a capture whose image changed;
- a record whose recorded bytes are all unchanged, unless you pass
  `--rereview`, so nothing is recorded without a change or a deliberate
  re-review.

It writes nothing unless every entry in the batch is valid. New records still
need their kind, summary and limits written by hand. It then lists records that
remain stale on inputs the batch touched, such as a page that cites a document
you just changed. With `--json`, the command and `docs:freshness:check` print a
machine-readable result, and a refusal carries a stable `code`.

A source can name one value in a JSON file by
[JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901), such as
`package.json#/scripts/docs:truth:gate` or `package.json#/engines`. Only that
value is hashed, and the binding names the commit that set it. Cite values
instead of a whole broad manifest when the page depends only on named scripts
or fields: adding an unrelated script then stales nothing, while changing a
cited value still does. Whole-file bindings remain right when a page describes
the manifest as a whole, such as its dependency set. Value bindings apply to
JSON files only; `pnpm-lock.yaml` and other YAML stay whole-file.

`--verify-bindings` lists each binding whose revision does not contain its
recorded bytes, such as bytes recorded before they were committed or a record
assembled by hand from two branches. Such a delta is only approximate.
Re-review the record with `--rereview` to rebind it.

A pull request that drops a cited source it also changes must add a review
note to that record, which `--drop-source` does. Deleting the citation by hand
leaves no note, and the scoped check refuses it. Removing a whole record while
its document remains and a cited source changed is also refused.

### Ledger layout and merges

GitHub computes whether a pull request can merge on the server, with Git's
default text merge. It never runs a local merge driver. The ledger is therefore
[a directory](../learn/review-ledger/) laid out so that independent reviews
merge as plain text:

| Path | Contents |
| --- | --- |
| `ledger.json` | Layout version and the catch-up `coverageBaseline` |
| `records/<document>.json` | One reviewed document: kind, state, summary, limits, document and source bindings, and notes recorded before this layout |
| `captures/<capture>.json` | One capture's source bindings; its metadata stays in `media.json` |
| `notes/<time>-<hash>.json` | The notes of one recording run, named by time and content hash |

Each document or source binding is one line holding its hash and revision. An
unchanged blank line separates it from the next binding, because Git reports a
conflict when two branches change adjacent lines. As a result:

- Two branches that refresh different sources of one record, such as the module
  map, or different records, merge without conflict. Each adds its own notes file.
- Two branches that review the same new bytes of a source bind the same commit.
  Their lines are identical, so they merge.
- Two branches that review different bytes of one source, including the
  document itself, change the same line and conflict, even when the source
  itself merges. Resolve by merging `main` and recording a new review of the
  merged bytes. Keeping one side's line leaves a stale record that the scoped
  check refuses.
- Two branches that add sources at the same place in one record conflict.

The loader accepts only the exact bytes the record command writes, so a
reformatted file cannot silently lose its separators. It rejects a notes file
whose content no longer matches its name, because notes are append-only, and
any unexpected file. Every consumer reads the compiled ledger through
[`review-ledger-store.mjs`](../../scripts/lib/review-ledger-store.mjs): freshness,
impact and catch-up, the learning reader, the knowledge-graph example and the
record command. Catch-up also reads the earlier single-file layout
(`docs/learn/review-ledger.json`) from history. The layout change alone never
puts a record into a change's scope.

A branch that recorded reviews in the old single file conflicts when it merges
`main`: the file is modified on the branch and deleted on `main`. Git leaves
the branch's version in the working tree. Fold it into the new layout while
the merge is still in progress:

```sh
node scripts/migrate-review-ledger.mjs --base "$(git merge-base HEAD MERGE_HEAD)"
git add -A docs/learn && git commit --no-edit
```

If the branch also re-reviewed a capture, `docs/learn/media.json` may conflict
too. Git can instead auto-merge away the old review fields. For a branch with
legacy capture reviews, use `git merge --no-commit origin/main` and run the
folding command before committing, even when Git reports no conflict.

The command reads both merge parents to recover those review fields and merges
each capture field against the merge base. It preserves the working copy's
metadata and review edits when Git already merged the file. Where both sides
changed one metadata field differently, it names the field and stops without
writing anything, so you resolve that field and rerun. It judges bindings to
`media.json` against the bytes it writes, not the conflicted working copy.

The command applies each record the branch changed since that base. It merges
bindings per source, adds the branch's appended checks as one new notes file
and deletes the old file. Where both sides reviewed different bytes of one
source, it keeps the binding that matches the current bytes. If neither
matches, the record stays stale, and the command names it so you can review it.
It also carries the branch's in-place edits to earlier checks, such as a
redaction. Where both sides edited the same check, or the branch removed one,
it keeps ours and names the record so you can apply the branch's change by
hand.

Staleness that no single pull request owns, such as two merges that combine,
is collected by the Nightly
[freshness sweep](../../.github/workflows/docs-freshness-sweep.yml). It runs
the catch-up report on `main` and keeps one tracking issue, titled
"Documentation freshness sweep", current. The issue is open while anything is
stale and closed when nothing is. The sweep never fails a required check.

Land a repository-wide audit in subsystem slices of roughly 20 to 40
documents, and merge each one before starting the next. A long audit branch
otherwise accumulates source changes from `main` faster than it can re-review
them.

## Generated release records and removed notes

Automatic release bookkeeping must not masquerade as a new human review. The
review compiler recognizes one named generated-output contract: the deploy
ledger. It validates the current JSON entries, rejects duplicate release
identities, and requires the exact Markdown projection for this repository.
The reviewed generator and validator source hashes must still match. Current
output receives a separate generated-validation status; the prior review
revision and hashes remain intact. This validates data shape and rendering,
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
