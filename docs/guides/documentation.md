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
