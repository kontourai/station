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

The learning reader's [review ledger](../learn/review-ledger.json) records
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
For each stale review it lists the changed inputs, the source revision reviewed,
and the last commit that edited the page. A page's edit commit is not proof
that someone reviewed its supporting code. Use the recorded revision and changed
paths to inspect the relevant Git diff; the hashes identify the exact bytes
previously reviewed, including changes that were uncommitted at that time.
Unchanged records do not need another whole-application review.

The ledger's `coverageBaseline` is the starting revision for searching new or
unmapped changes during catch-up; `--base=<ref>` overrides that search. It is
separate from each page's review revision. Advance it only after accounting for
its outstanding coverage, never just to shorten a report. A missing baseline
requires an explicit ref. Both modes report files with no known documentation
dependency. Trace those through actual callers, add missing source relationships,
or give a concrete no-documentation-impact reason in the PR.

The map records reviewed relationships. It does not discover every code import,
runtime call, dependency default or business requirement. Broad owners such as
the module map can select many topics. Periodic audits still need to look for
missing relationships. Run `docs:truth:gate` after reviewing and updating the
ledger; the impact report does not change evidence or grant approval.

Veritas selects this command as required `documentation-truth` evidence,
including for source-only changes. A stale recorded review blocks readiness;
unmapped dependencies and prose accuracy still require review. The
[activation record](../../.veritas/init-plans/documentation-maintenance.md)
retains the owner approval and failure/restoration controls.

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
