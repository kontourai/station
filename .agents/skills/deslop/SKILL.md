---
name: deslop
description: "Diff-scoped AI-slop cleanup pass: strip comment slop, defensive-check slop, type-laundering, and style drift from the current branch diff before independent review."
---

# Deslop

Clean only the current branch diff before review. Preserve behavior absolutely.

Adapted from OpenClaw's `deslop` skill (MIT, openclaw/openclaw@203aafc).

## Checklist

1. Scope the pass to `git diff` against `origin/main`, or the branch merge base when it differs. Never run a repo-wide cleanup.
2. Inspect every changed hunk for:
   - comments a human maintainer would not write, including narration, syntax explanation, and prose that merely restates the code;
   - defensive checks or `try`/`catch` blocks that are abnormal for the surrounding module or protect only imagined states;
   - casts that launder types, especially `as any`, `as unknown as T`, and widen-then-assert flows. `scripts/type-laundering-gate.mjs` (in `npm run verification:policy:gate`) already rejects new `as any` and `as unknown as T` casts in production code;
   - redundant intermediate variables or one-use helpers that do not add domain meaning, reduce duplication, or simplify control flow;
   - compatibility shims, aliases, retries, and fallback branches without a named shipped contract and removal plan;
   - naming, control flow, imports, formatting, and other style that conflicts with the surrounding file.
3. Make no functional edits. If cleanup could change behavior, leave it alone and report it instead.
4. Fix a finding inline only when the cleanup is trivial and behavior-neutral. Otherwise note it for the author.
5. Report the result in 1–3 sentences, including whether anything changed and any non-trivial item left for review.

Run `$deslop` before independent review, never instead of it. The report-only review and verification described in the root [AGENTS.md](../../../AGENTS.md) remain the required correctness and safety gate.
