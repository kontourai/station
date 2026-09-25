---
name: deslop
description: Diff-scoped AI-writing cleanup pass before review. Strips narration comments, imagined-state defensive checks, type-laundering casts, and style drift from the current branch diff. Behavior-neutral by contract; feeds, never replaces, independent review.
---

# Deslop

Clean the current branch diff before review. Preserve behavior absolutely.

## Scope

1. Run against `git diff` from the merge base with `origin/main`, or the branch's merge base when it differs. Never run a repo-wide pass; repo-wide cleanup belongs to its own reviewed pull request.
2. Stabilize work in progress first (commit or stage). The pass edits only intent the diff can see.

## Checklist

Inspect every changed hunk for:

- comments a maintainer would not write: narration, syntax restatement, prose that repeats the code, or a claim about behavior the code does not have;
- defensive checks or try/catch blocks that are abnormal for the surrounding module or protect only imagined states;
- type laundering: `as any`, `as unknown as T`, and widen-then-assert flows. Lint does not reject this class today, so this pass is the backstop;
- redundant intermediate variables or one-use helpers that add no domain meaning;
- compatibility shims, aliases, retries, or fallback branches without a named shipped contract and removal plan;
- naming, control flow, imports, or formatting that conflicts with the surrounding file.

## Rules

- Make no functional edits. If a cleanup could change behavior, leave it alone and report it.
- Fix a finding inline only when it is trivially behavior-neutral. Note the rest for the author or review.
- Report in 1-3 sentences: whether anything changed, and any non-trivial item left for review.

Run deslop before review, never instead of it. Nontrivial changes still need independent review under the layered-independence protocol (`docs/strategy/multi-agent-delivery-protocol.md`). The standing repo conventions this pass enforces on a diff are owned by [Code-health prevention](../../../../docs/guides/code-quality.md#code-health-prevention).
