# Code Quality & Push Workflow

## Repo git hooks

Station ships its own hooks in `.githooks/`, version-controlled so they travel
with the branch and every worktree behaves the same. Bootstrap a root checkout
through the dependency lifecycle runner:

```bash
npm run dependencies:ci       # fresh, lockfile-exact checkout
npm run dependencies:install  # refresh an existing developer checkout
```

Both commands install with npm lifecycle scripts disabled, then run only the
reviewed lifecycle allowlist, Station's explicit patch step, and Git-hook
setup. To repair hook setup alone:

```bash
npm run hooks:install    # git config core.hooksPath .githooks
```

`npm run gate:for [-- <paths...>]` prints which of the scoped checks below a
change surface feeds, using the hook's own scope deciders — ask it before
writing to know what a change will owe.

The pre-push hook runs seven checks, in this order (the hook file,
`.githooks/pre-push`, is the source of truth if this table drifts):

| Check | Cost | Refuses |
| --- | --- | --- |
| `node scripts/check-merge-base-fresh.mjs` | instant | a branch that does not contain current `origin/main` |
| `npm run lint:check` | ~4s | a lint, formatting, or organize-imports error |
| `node scripts/check-prepush-ui-bundle.mjs` | ~9s, and only when the push changes a UI build input | a tree over the entry-bundle ceiling |
| `node scripts/check-prepush-orchestration-transfer.mjs` | scoped; requires a prepared exact-main baseline when orchestration transport inputs change | missing, stale, incomplete, or over-budget two-baseline-plus-candidate transfer evidence |
| `node scripts/check-prepush-static-gates.mjs` | ~7s, and only when the push changes something these gates read | a UI-contract ratchet or content-gate violation (archive#3208) |
| `node scripts/check-prepush-sdk-barrel.mjs` | ~6s, and only when the push changes the SDK's own sources | an SDK export missing from the public barrel (archive#3629) |
| `node scripts/commit-message-gate.mjs --prepush-stdin` | instant | a commit subject in the push range that breaks the conventional grammar the forthcoming deploy-ledger changelog (archive#4572) will generate from |

The transfer check has a finite capture **liveness timeout**, which only bounds
a hung subprocess; it is not a performance score or a product budget. Prepare
its independent baseline before pushing a scoped change:

```bash
npm run transfer:gate -- --prepare-baseline \
  --baseline-root ../station-worktrees/4294-transfer-baseline-<main-sha> \
  --base origin/main
(cd ../station-worktrees/4294-transfer-baseline-<main-sha> && npm run dependencies:ci)
STATION_TRANSFER_BASELINE_ROOT=../station-worktrees/4294-transfer-baseline-<main-sha> \
  npm run transfer:gate
```

The capture reports are diagnostic transfer evidence, not completion evidence.
Nothing slower belongs here. `ci:fast` remains the bounded five-minute feedback
lane and `full:regression` remains the sole completion receipt; the hook holds
only the subset that is cheap enough to run on every push *and* whose failure
would otherwise land on `main` and stop every other lane.

**Why the last two moved here.** Both already existed inside `verify:static`,
which runs after the whole Vitest corpus — so they failed on whoever gated
next rather than on whoever caused the break, and each discovery cost a full
gate cycle. On 2026-08-17 that shape cost six: `main` sat red for hours on one
unformatted parameter list, with two lanes independently applying the identical
three-second fix because neither could merge without carrying it (archive#3141); and
the entry-bundle ceiling needed reconciling on five separate merges, with
unowned raises consumed within hours (archive#3033). Run at push time, both become
correctly attributed by construction: an over-ceiling UI tree cannot leave the
machine, and a ceiling raise happens in the branch that spent the bytes.

### What the entry-bundle ceiling is for

It is a forcing function for reuse, not an accounting exercise. The entry
bundle is what a browser downloads, parses and executes before a user sees
anything — paid on every cold load, by every user, on whatever connection and
device they have. It is the one number in this repo that converts directly
into someone else's waiting, which is why it is gated at all.

The ceiling makes that cost visible at the moment an addition is made, while
reuse is still cheap to choose. When it reds, the question to ask first is not
*may I raise this* but *what does a user get for these bytes* — and then the
DRY questions, which are the ones that shrink the tree instead of relocating
it:

- Does a primitive for this already ship? (See
  [State primitives](../../src-ui/src/components/state/index.ts) and
  [Shell skeletons](../design/shell-skeletons.md) — both exist because bespoke
  duplicates accumulated.)
- Does the first paint need this surface, or can it lazy-load?
- Is there a dead sibling next to the live one to delete in the same change?

Raising is legitimate and it is the **last** step, after those. Raise by what
you measured, in the branch that spent it, with the number in the commit
message — the next reader can only tell a considered raise from a reflexive
one by what you wrote down, and a reflexive one teaches every later lane that
the number is paperwork. `scripts/ui-bundle-budget.mjs` prints the same three
steps when it fails.

The bundle check is scoped to the branch delta against `origin/main`, so a
server-only push does not pay for a UI build. It measures when that delta
touches `src-ui/`, `src-shared/`, the `packages/{sdk,connect,contracts}/src/`
sources the Vite aliases resolve, `vite.config.ts`, either manifest (a
dependency bump moves the bundle without touching a source file), or the
budget script and its ceiling. When the scope cannot be computed at all, it
measures rather than assuming — see *a default that decides*, below. It builds
into `dist-ui-prepush/` so a push never replaces the `dist-ui/` a running dev
server or desktop app is serving.

There is deliberately no per-check escape hatch for either. Unlike a stale
base, which can be a legitimate state of a branch you do not fully control,
both of these are properties of your own tree that you can fix in seconds —
and a bypass would reproduce exactly the unowned-raise loop archive#3033 exists to
close. `git push --no-verify` remains for a genuine emergency.

**Why the merge-base check exists.** A pre-push gate verifies the branch you are pushing, not
the tree that will land. Once `main` moves, a squash-merge produces a
combination nobody ran the gate against. On 2026-07-25 that broke `main` four
times in one day — a lint error, unorganized imports, three
accessibility-ratchet violations, and a typecheck failure from a usage-field
mapping that has been reverted three times. Every one of those branches was
green when pushed.

GitHub would normally close this with *require branches to be up to date before
merging*, and required status checks would catch it too. Neither is available
here: branch protection returns 403 on a private repository without a paid plan,
and Actions is billing-blocked. A local hook is the enforcement point that
remains.

Deliberate exception to the merge-base check, for a single push:

```bash
STATION_ALLOW_STALE_BASE=1 git push ...
```

Prefer that over `--no-verify`, which skips every hook rather than this one.


## Local CI Pipeline

Run these in order before pushing — they mirror CI:

```bash
cd packages/sdk && npm run build && cd ../connect && npm run build && cd ../..
npx tsc --noEmit --skipLibCheck    # zero errors
npm run lint                        # zero biome warnings
npm run build:server && npm run build:ui
npm test -- --run                   # all tests pass
```

> `packages/shared` has no build step — it's consumed directly as TypeScript source by the server and other packages.

## Biome Lint

Auto-fix safe issues: `npx biome lint src-server/ src-ui/ packages/ --write --unsafe`

Common gotchas:
- `noUnusedImports` — SDK uses `react-jsx` transform, so `import React` is NOT needed. If you see `'React' refers to a UMD global`, the tsconfig is wrong, not the import.
- `useExhaustiveDependencies` — verify deps are correct before accepting auto-fix.
- `noUnusedVariables` / `noUnusedFunctionParameters` — prefix with `_` if intentionally unused.

## Route Typing

All Hono route handlers use helpers from `src-server/routes/schemas/schemas.ts`:
- `getBody(c)` instead of `c.get('body')` — avoids Hono's `unknown` return type
- `param(c, 'name')` instead of `c.req.param('name')` — returns `string` (throws 400 if missing)

Always import from schemas. Never use raw `c.get('body')` or `c.req.param()`.

## Clean Core

The core must remain vendor-neutral and free of organization-specific references. No hardcoded company domains, internal tool names, employee identifiers, or proprietary service URLs should appear in source code, configs, or comments. Before pushing, scan the diff for anything that couples the core to a specific organization and remove it. Default implementations should work for any user out of the box.

## Smell: a default that decides

Not all fallbacks are equal. The dangerous shape is a default that turns **"I
don't know"** into a confident, plausible, usually-permissive value **at a
decision point**.

The question to answer, every time you write or review one:

> Does this default participate in a **decision**, or only in **display**?

A display default degrades legibly — a slightly wrong label, visible to whoever
looks. A decision default launders absence into permission, and permission is
exactly the thing nobody can see is wrong.

Real instances, all found the hard way:

- `prerequisites ?? []` — "nothing required is missing" → **ready**. A candidate
  we could not verify counted as verified.
- `settings.enabled ?? true` — "no setting" → **enabled**, so a connection the
  user had switched off still reported chat-ready.
- `notification.actions ?? []` — an action-less approval that still suppressed
  the composer, leaving a session with no way to respond at all.
- `query.data?.items ?? []` — a *fetch failure* renders identically to "nothing
  needs your attention."
- `adapter.metadata.runtimeId ?? adapter.provider` — a well-formed key that
  matched nothing, because the real key is `${provider}-runtime`.

Contrast the harmless ones: `?? UNKNOWN_EXTERNAL_ENGINE_MATRIX` defaults to
something *named* as unknown; `?? 'Active'` is a label. Both stay honest.

Optional chaining compounds it. In
`deps.getAppConfig?.()?.agentConnections?.[id]?.enabled ?? true` there are four
places to become `undefined` before the default — a renamed field, a missing
dep, the wrong key — and every one yields the same answer as *the user didn't
disable it*. The expression cannot tell **not disabled** from **couldn't look**.

**The test.** Inject the unknown case — remove the method, drop the key, fail
the fetch — and check the result is distinguishable from the permissive case.
If it isn't, the default is deciding on evidence it does not have.

**The fix is usually to refuse rather than guess.** This codebase already has
the idiom:

```ts
// A candidate we cannot actually verify must never count as ready.
if (typeof adapter.getPrerequisites !== 'function') continue;
```

Skip, throw, or surface the uncertainty. Reserve `??` for cases where absence
genuinely has a correct meaning, and say so in a comment when it does.

## Smell: guards that defend the recoverable thing

Sibling to the above. That one asks whether a default *decides*; this one asks
whether a safety check defends **the state that cannot be got back**.

The question, for any code that deletes, overwrites, truncates, or expires:

> Which state here is irrecoverable, and does a guard defend **that** — or only
> the state that was easiest to check?

The failure is not a missing guard. It is a *plausible set* of guards, each
individually sensible, that collectively defend data which was never at risk.
Nobody reviewing the list notices, because every entry on it is defensible.

**The instance that produced this section** (archive#3205). A tool that removes
finished git worktrees guarded on: not the primary checkout, not the current
worktree, branch fully merged, no unpushed commits, no modified tracked files,
nothing touched recently. Six guards, all reasonable, all tested.

But `git worktree remove` **never deletes the branch**, so committed work always
survives removal regardless of any of them. It also *refuses outright* on a
worktree containing modified or untracked files — and `--force`, which the tool
passed, is precisely what converts that refusal into deletion. So uncommitted
state was the entire loss surface, and of that, untracked files — the only bytes
that exist in exactly one place on earth — were **deliberately excluded**, with
a comment justifying it and a test named `untracked files are reported but never
keep a worktree alive`.

Five of six guards defended data that was already safe in git. The sixth
category was the one that could not be recovered, and it was the one waved
through. Verified end to end: git refused, `--force`
deleted a hand-written source file, nothing recoverable.

(That is the *corrected* version, not the shipped one — the tool now keeps any
worktree holding an untracked file git is not ignoring, and no longer passes
`--force`. The point worth keeping is that the original guard list looked
complete to its author and to its tests.)

**How to run the check.**

1. Name the irrecoverable state explicitly — the bytes with no second copy.
   Not "user data", not "their work": *which* bytes, and where else they exist.
2. Ask what the platform already does for you. `git worktree remove` refuses;
   `rm` does not; a `DELETE` with a foreign key may refuse; a soft delete does
   not. A guard that duplicates a refusal you then suppress is worse than no
   guard, because it reads as protection.
3. Treat **suppression flags as the guard's real subject**. `--force`,
   `{ force: true }`, `ON DELETE CASCADE`, `--no-verify` — whatever silences the
   platform's own objection is where the danger concentrates. Justify it
   separately from the feature.
4. Prove the rejection path executes. Every guard in that tool was asserted only
   in prose; eight injections against the I/O layer — including "the primary
   checkout becomes removable" and three error handlers flipped to fail *open* —
   were caught by exactly zero of sixteen passing tests, because the tests only
   ever exercised the pure decision function.

**Fail closed on what you could not determine.** An unreadable directory, a ref
that will not resolve, a probe that errored: each must keep the thing, not clear
it. A `catch` that returns a clean zero has decided on evidence it does not have
— the same defect as a default that decides, wearing safety gear.

## Push & Monitor

Push to all configured remotes (`git remote -v` to list). After pushing, use `gh` (if available) to monitor CI pipeline status until all workflows pass.
