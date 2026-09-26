---
name: test-audit
description: "Invoke whenever writing, changing, reviewing, or sweeping tests. Authoring gate for new tests plus audit workflow for low-value, implementation-coupled, or duplicative tests and the test-only production seams they demand."
---

# Test Audit

Three modes, one value bar. Authoring mode gates every new or changed test at
write time. Audit mode runs focused sweeps of tests that re-assert source,
duplicate stronger proof, couple behavior to implementation, or keep test-only
production seams alive. Continue broad audits as separate coherent follow-up
PRs; optimize for confidence, not deletion count. Campaign mode prunes one
whole subsystem's test surface (every test file a package or server/UI area
owns); before starting one, read [CAMPAIGN.md](CAMPAIGN.md).

Adapted from OpenClaw's `test-audit` skill (MIT, openclaw/openclaw@80930af).
The method is unchanged; discovery lanes, validation, and landing use
Station's commands. Station's own testing rules in
[docs/guides/testing.md](../../../docs/guides/testing.md#fixture-fidelity-and-test-effectiveness)
take precedence where they are stricter.

## Authoring gate

Before adding any test, answer four questions; a missing answer means do not
add it yet:

1. What observable behavior, invariant, or independent contract does it protect?
2. What credible regression makes it fail?
3. Why does existing coverage not already catch that failure? Each contract has
   one primary test owner at the strongest boundary; another layer needs its
   own distinct risk, such as a transport or lifecycle failure the owner cannot
   reach. Prefer extending a table-driven case or shared fixture over a
   near-duplicate test; consolidate duplicated setup in the same change.
4. Does it need a production seam (export, flag, wrapper, injection hook) that no
   production caller needs? If yes, move the test to the real boundary instead.

Then check the test against every [junk pattern](#junk-patterns); a match fails
the gate unless the [retention bar](#retention-bar) names the contract it
independently guards. A test that would break under behavior-preserving
refactoring is asserting implementation, not behavior; rewrite it at the
owning boundary before landing it.

Bug regression tests must fail on the pre-fix code for the intended reason and
pass after the owner-boundary repair. A regression test that never demonstrably
failed proves the mock, not the fix. One regression at the owner boundary
covers the bug; do not replay the same scenario at every layer it crosses.

## Junk patterns

The shared checklist for both modes: the authoring gate rejects a new test that
matches one, and audits hunt for existing tests that do.

- assertion-free coverage probes;
- self-comparisons and identity copiers;
- copied fixtures, inventories, manifests, or export lists;
- exact source, import, or string greps;
- private predicate or call-shape tests duplicated at real boundaries;
- duplicate invocations of the same contract;
- provider-local replays of shared helpers;
- tests whose only purpose is preserving test-only exports, globals, or wrappers;
- dead production code whose only callers are tests;
- expected values produced by the helper or renderer under test;
- mocks that implement the asserted behavior, or one identical mock standing in
  for different APIs;
- fixtures that supply the receipt, admission, or callback ordering the owner
  should produce, or persistence asserted against a store the path never writes;
- capability tests that restate declared flags instead of exercising the
  delivery or acknowledgement the flag promises;
- negative controls that pass for an unrelated reason, such as a denial from a
  different guard or a rejection the production path never reaches;
- names or fixtures that promise more than the input exercises, such as a
  "retires the window" test asserting the window was not cleared.

## Value bar

Tests justify their maintenance cost by protecting behavior, a credible
regression, or an independently meaningful contract. In an audit, an existing
test that must change for behavior-preserving source reorganization is suspect,
not automatically deletable; the authoring gate still rejects new ones.

Before judging a candidate, read the complete test and production owner, its
entry point, callers, callees, sibling implementations, overlapping tests, CI
routing, and relevant history. Read root and scoped `AGENTS.md` files first.
When the test claims dependency-backed behavior, inspect the dependency source
or types directly.

## Discovery

Keep discovery read-only and report evidence before editing. For broad scope,
run parallel discovery lanes when available:

- server (`src-server/`);
- UI (`src-ui/`);
- packages and end-to-end tests (`packages/`, `tests/`);
- scripts, gates, and tooling (`scripts/`, `.github/`, root configuration).

Discovery uses a detached worktree at a pinned `origin/main` SHA so every lane
reads the same tree. `npm run test:fixtures:check -- --inventory` lists the
known fixture-policy sites, and the code-health report from `npm run ci:fast`
lists unused exports; neither list is a verdict on its own.

Outside campaign mode, prefer a few high-confidence candidates over a large
speculative inventory. Hunt for the [junk patterns](#junk-patterns).

## Retention bar

Keep a test when it independently enforces a public API, plugin SDK, protocol,
config, migration, storage, security, platform, default, prompt-byte, generated
cross-language, package, release, or architecture contract. Also keep:

- call ordering when order is observable behavior;
- regressions with a credible failure mode;
- source inspection when it is the cheapest independent guard: it fails when
  the contract changes (the user-facing key, byte, or path) and survives an
  identifier-only refactor;
- a retained test that fails on the baseline: treat it as a possible product
  bug, reproduce it, and repair the owner rather than deleting it.

Static or slow is not a deletion reason. A test that resembles implementation
may still be the independent contract; prove otherwise before removing it.

## Candidate evidence

Record every field below before editing. A missing field means the candidate is
not ready for deletion:

- exact test name and location;
- what failure it can actually detect;
- non-test callers of the covered production or support seam;
- stronger remaining owner-boundary proof, or why no proof is needed;
- relevant history and the reason the test or seam exists;
- production or test-support deletion unlocked;
- risk and the focused validation command.

## Edit shape

Choose one coherent owner-boundary batch. Delete obsolete test-only exports,
globals, wrappers, and dead production paths instead of preserving aliases.
Move retained regressions to their canonical owners. Consolidate repeated
package or dependency assertions into one generic contract.

Prefer net-negative production LOC. Do not add replacement tests that restate
the same implementation, and do not convert uncertain candidates into cleanup
to increase deletion counts.

## Validation

Never edit source or tests while Vitest is running in the worktree. Follow
[docs/guides/testing.md](../../../docs/guides/testing.md); edit only in a
sibling worktree under `../station-worktrees/`.

1. Before editing, run `npm run gate:for -- <paths...>` and follow the checks
   it routes to.
2. Run the smallest owner and sibling tests with
   `npm run test:focused -- <file...>`, not ad-hoc `npx vitest`.
3. For a retained or repaired assertion, prove it can fail: commit, confirm
   `git status --short` is empty, break the production owner, confirm the
   named test goes red for the intended reason, restore, and re-run green.
   `npm run test:mutation:smoke` is the curated form of this check.
4. For removed source greps or plan assertions, run the executable script or
   gate that owns the real contract, as a child process, and assert its exit
   status.
5. Run `git diff --check`,
   `npm run test:changed -- --base=origin/main --explain`, then
   `npm run ci:fast`. Exit 3 from the selector is provisional, not completion.
6. Inspect `git diff --numstat`; report production/tooling separately from
   tests and test support. Update `scripts/test-fixture-policy-baseline.json`
   when a deleted test removes a legacy site.
7. After final audit edits, get an independent report-only review of the
   deletions against their named keepers.

## Landing and continuation

Commit, push, open a PR, or land only when authorized. Land through the merge
queue as described in the root [AGENTS.md](../../../AGENTS.md#landing-a-pull-request).
Land one coherent PR at a time; after landing, refresh from current `main` and
rerun read-only discovery for the next high-confidence batch.

## Handoff

Report:

- root cause and removed low-value categories;
- production owner simplifications;
- retained false positives and why they remain valuable;
- focused and full proof actually run;
- production versus test LOC;
- PR and merge state;
- named follow-ups.
