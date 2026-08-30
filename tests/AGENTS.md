# Test scope

Tests prove observable contracts, not implementation accidents. Read the matching source scope as well as this file. Use `npm run test:focused -- <file...>` and keep fixtures hermetic; tests that start child processes or own shared output require the declared resource classification.

Do not represent a selector explanation, a deferred selection, or a rerun as completion evidence. Read [testing guidance](../docs/guides/testing.md) for the canonical lanes and escalation policy.

## A test must execute the seam it is named for

Before adding or accepting a test, answer both: **does it reach the code its name claims**, and **would it fail if the fix were reverted?** A test that satisfies its name without touching its subject is worse than no test, because it retires the question — the next reader sees coverage and stops looking.

Recurring shapes to reject:

- Asserting a constant against its own literal, rather than the value the production caller constructs.
- Asserting source text or config shape (a regex over a file, a substring of workflow YAML) when the behaviour is what matters — that passes whether or not anything implements the flag or the rule.
- Exercising a pure reducer or helper while the defect lives in the integration that calls it.
- Sitting behind a catch-all that converts the condition under test into an ordinary return, so the guard the test is named for is never reached.

When a mutation is the only convincing evidence, commit first, confirm `git status --short` is empty, then inject — a `git checkout --` restore on a dirty tree silently discards uncommitted work. Report the red result, not only the green one; an injection that does not fail means the test lacks power or the mutation never reached the case, and either way the test is unproven.

A fix round is where defects are introduced most often, so review the delta of a fix, not only the original change.
