# Local merge-readiness protocol (provider-hosted CI outage)

> Status: **active while provider-hosted jobs fail at zero steps**. As of 2026-08-01,
> the private self-hosted build fleet supplies post-merge operational detectors for
> CI, container, Windows, Android, and Secret Scan, while provider-hosted publish and
> Pages jobs can still fail before executing because of organization billing. A green
> detector result describes the `main` tree it ran against and **cannot clear a
> candidate pull request diff**. Inspect the live job steps before classifying a
> failure: zero executed steps are `NOT_VERIFIED`, not green and not a product
> regression. When provider-hosted execution returns, re-run those lanes on main's
> tip, confirm their result, and retain this document as the outage record.

Precedent: the owner-authorized July local-gates policy (2026-07-24) and the
subsequent merges operating under it (2026-07-26).

## Selector-first outage protocol

1. Start with `npm run test:changed -- --base=origin/main --explain`. Its exit 0 only
   means an explanation was emitted; exit 3 is provisional/deferred. Read the named
   focused test or escalation lane.
2. Run selected exact Vitest files with `npm run test:focused -- <file...>`, plus the
   affected TypeScript/Biome checks. The wrapper pins and verifies the active worktree
   root and fails when existing files collect zero tests. For a red proof, read the
   failure text and confirm it names the intended guard; the color alone is not
   provenance. Escalate to a public static or local lane only when the selector or
   change risk justifies it.
3. Use native compilation or full E2E only when the selector names that surface or the
   final risk requires it. For an E2E failure, compare the same bucket on `origin/main`
   in the same environment; disclose any baseline result and any NOT_VERIFIED gap.
4. Keep the branch fresh with `origin/main`, use independent review or fault injection
   where the change's risk warrants it, and state the local evidence basis in the PR.
   Do not cite a green self-hosted CI or Secret Scan result as PR clearance: those
   workflows run after merge and do not evaluate the candidate diff.
5. Use `npm run ci:fast` for bounded affected-test feedback, then run
   `npm run full:regression` once as the final local checkpoint. Its coordinated
   lane exit 0 may mean executed, joined, or reused; it is the sole completion receipt.

Docs-only changes can usually stop after selector-guided focused checks and the final
checkpoint; record the scope and evidence in the PR. Production-touching actions
(deploys, schedules, real-data runs) remain owner-gated and outside this protocol.

## When the gate is red for something that is not yours

`main` breaks. A lane that gates after the break inherits a red naming files it
never touched, and the default — fix it forward so your own lane can land — is
usually right. It is not always right, and the failure mode of getting it wrong
is worse than waiting.

**Prove it is inherited before anything else.** Reproduce the failure on a
pristine `origin/main` worktree (`git worktree add --detach`, never an extracted
tree — see the delivery protocol's failure mode 6). "Not in my diff" is a weak
claim on its own; `git diff origin/main...HEAD` compares against the *merge
base*, so a branch that is behind main can show zero changed files in a
directory whose tree hash differs. Compare tree hashes, or merge main first and
re-measure. A break your branch inherited from a **stale** base may already be
fixed upstream, and merging is then the whole fix.

**Fix forward when the correct fix is mechanical and you can verify it.** A
missing inventory entry, an unformatted file, a declaration that has one right
answer. Say in the commit message that it is a fix-forward on an inherited
break, and name the commit that introduced it.

**File instead of fixing when the fix requires judgement you do not own.** The
case that produced this section: `main` failed a source invariant because
another lane's new fixture cast past it. Removing the cast surfaced three type
errors — the fixture named a control mode, a status, and an agent id that do not
exist in the contracts. Two attempted fixes were both wrong (one passed
`npx tsc -p tsconfig.json`, which *excludes* test files, and failed the real
lane's typecheck), and the correct fix meant choosing semantically right values
for assertions belonging to a lane mid-flight. Substituting plausible-looking
values would have turned the suite green while it still asserted a shape that
cannot occur — which is precisely the defect the invariant exists to catch, one
level down. **A green suite asserting the wrong thing is worse than a red one.**

Both attempts were reverted and the break was filed with the three compiler
errors quoted verbatim, so its owner could fix it in minutes.

**Then a disclosed-red merge is legitimate, and it needs all of this:**

- every gate failure reproduced on pristine `origin/main` and named in the PR,
  with the issue number for each;
- your own change's evidence complete and independent of the gate — focused
  lanes green, new tests shown failing without the production change, fault
  injections naming their guards, independent review;
- an explicit statement that the completion receipt is **not** green and why it
  is currently unobtainable for any lane.

What this never licenses: re-running until a flake turns green, merging past a
failure you have not diagnosed, or attributing a red to "main is broken"
without the pristine-main reproduction. The bar is *disclosed*, not *waived*.

Companion: `multi-agent-delivery-protocol.md` records the delivery discipline
around this evidence basis (pipeline roles, fault-injection rules, flake
triage, batch merges) as codified 2026-08-01.

## What this protocol is not

The outage does not lower what "verified" means and does not turn provider startup
failures into evidence. The coordination and receipt machinery is durable repository
infrastructure for multi-worktree execution: it selects focused feedback, prevents
redundant heavyweight runs, and preserves command-backed evidence independently of the
provider outage. Do not add outage-specific bypasses that weaken those gates.
