#!/usr/bin/env node
/**
 * Run every independent `typecheck:*` sub-lane to completion and report every
 * failing one (station#4249 slice 2).
 *
 * `npm run typecheck` used to chain 12 independent TypeScript projects with
 * `&&` (plus a `dist:freshness` precondition ahead of them). The first
 * failure ended the run, so a branch inheriting two independent typecheck
 * breaks from a moving `main` cost two full receipt cycles to discover what
 * one run could report: attempt #1 in station#4249's motivating incident died
 * on `typecheck:server-tests`; attempt #2, a cycle later, died on
 * `typecheck:ui` -- a project the first attempt never even reached.
 *
 * `dist:freshness` is deliberately NOT one of the lanes below and is not run
 * by this script at all: it is a real precondition (station#1813,
 * `scripts/check-dist-freshness.mjs`) every one of the twelve projects
 * depends on -- a stale `packages/connect/dist` produces bogus type errors in
 * unrelated consumer files, which would make this script's "every lane"
 * report full of noise rather than signal. `package.json`'s `typecheck`
 * script keeps `dist:freshness` chained fail-fast ahead of this one:
 * `npm run dist:freshness && node scripts/typecheck-aggregate.mjs`.
 *
 * Every sub-lane's own command is UNCHANGED -- this script only changes how
 * many of the 12 independent projects run per invocation, never what any one
 * of them compiles or how.
 */
import { invokedDirectly } from './lib/module-entry.mjs';
import { runLanesToCompletion } from './lib/npm-lane-aggregate.mjs';
import {
  describeSlotSource,
  resolveSlotCount,
} from './lib/typecheck-host-slots.mjs';

/**
 * The independent projects `typecheck`'s old `&&` chain named, each pointing
 * at the SAME unmodified npm script, less the production server program its
 * tests program already contains (see below).
 *
 * Ordered longest-first (#2577). Lanes start in list order as slots free, and
 * the old chain order put the longest lane (`typecheck:examples`, ~80s on a
 * hosted runner) last, where it ran alone after everything else finished.
 * Replaying the per-lane times of 82 hosted `fast-checks` runs (two slots)
 * through both orders: median wall 191s in chain order, 166s longest-first,
 * against a 164s floor (half the summed compile time). The order changes when
 * each project starts, never what any of them compiles; results are still
 * reported for every lane. Re-sort if a lane's hosted time moves past its
 * neighbour's.
 *
 * `scripts/__tests__/guardrail-known-bad-fixtures.test.ts` asserts
 * `typecheck:scripts` (station#1805's exhaustiveness gate) is a member of
 * this catalog and unchanged, rather than grepping `package.json`'s
 * `typecheck` field for it now that the field itself is a single command.
 */
export const TYPECHECK_LANES = [
  { id: 'typecheck:examples', script: 'typecheck:examples' },
  // No `typecheck:server` (`tsc -p tsconfig.json`). tsconfig.tests.json
  // extends it without overriding a single compiler option and includes a
  // strict superset of its files (it drops only the `**/*.test.ts` exclude),
  // so every diagnostic the production program can report on those files is
  // reported by `typecheck:server-tests` too, and the lane spent ~62s of a
  // hosted runner's CPU (fast-checks run 35784946947) re-deriving it.
  // typecheck-aggregate.test.ts pins that premise; if it breaks, restore the
  // lane. What the superset cannot see: a production file that only compiles
  // because a test file declares a global or a module augmentation. No test
  // under src-server/ or src-shared/ does today.
  { id: 'typecheck:server-tests', script: 'typecheck:server-tests' },
  { id: 'typecheck:ui', script: 'typecheck:ui' },
  { id: 'typecheck:scripts', script: 'typecheck:scripts' },
  { id: 'typecheck:e2e', script: 'typecheck:e2e' },
  { id: 'typecheck:cli', script: 'typecheck:cli' },
  { id: 'typecheck:sdk', script: 'typecheck:sdk' },
  { id: 'typecheck:shared', script: 'typecheck:shared' },
  { id: 'typecheck:connect', script: 'typecheck:connect' },
  { id: 'typecheck:board-pane', script: 'typecheck:board-pane' },
  { id: 'typecheck:contracts', script: 'typecheck:contracts' },
  { id: 'typecheck:basis-pane', script: 'typecheck:basis-pane' },
];

/**
 * Every lane's compiler takes a host-wide slot (`scripts/tsc-slot.mjs`), so
 * starting more lanes than there are slots only adds idle npm/node processes
 * queued behind them. The per-invocation concurrency is capped at the slot
 * count; the slots themselves bound the total across worktrees.
 *
 * @param {{ env?: NodeJS.ProcessEnv, concurrency?: number }} [options]
 *   Annotated because `tsconfig.scripts.json` runs with checkJs:false, where
 *   an undefaulted destructured property is dropped from the inferred type.
 */
export function typecheckConcurrency({ env = process.env, concurrency } = {}) {
  const slots = resolveSlotCount({ env });
  return Number.isInteger(concurrency) && concurrency > 0
    ? Math.min(concurrency, slots)
    : slots;
}

export async function runTypecheckAggregate(options = {}) {
  const concurrency = typecheckConcurrency({
    env: options.env,
    concurrency: options.concurrency,
  });
  // Printed once per run so CI output shows the cap it actually ran under.
  (options.log ?? console.log)(
    `typecheck: ${resolveSlotCount({ env: options.env })} host typecheck slot(s) (${describeSlotSource({ env: options.env })}); running up to ${concurrency} lane(s) at once.`,
  );
  return runLanesToCompletion({
    lanes: TYPECHECK_LANES,
    label: 'typecheck',
    ...options,
    concurrency,
  });
}

if (invokedDirectly(import.meta.url)) {
  const ok = await runTypecheckAggregate();
  if (!ok) process.exitCode = 1;
}
