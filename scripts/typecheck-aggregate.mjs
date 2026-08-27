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

/**
 * The same 12 independent projects `typecheck`'s old `&&` chain named, in the
 * same order, each pointing at the SAME unmodified npm script.
 * `scripts/__tests__/guardrail-known-bad-fixtures.test.ts` asserts
 * `typecheck:scripts` (station#1805's exhaustiveness gate) is a member of
 * this catalog and unchanged, rather than grepping `package.json`'s
 * `typecheck` field for it now that the field itself is a single command.
 */
export const TYPECHECK_LANES = [
  { id: 'typecheck:server', script: 'typecheck:server' },
  { id: 'typecheck:server-tests', script: 'typecheck:server-tests' },
  { id: 'typecheck:scripts', script: 'typecheck:scripts' },
  { id: 'typecheck:cli', script: 'typecheck:cli' },
  { id: 'typecheck:contracts', script: 'typecheck:contracts' },
  { id: 'typecheck:connect', script: 'typecheck:connect' },
  { id: 'typecheck:sdk', script: 'typecheck:sdk' },
  { id: 'typecheck:basis-pane', script: 'typecheck:basis-pane' },
  { id: 'typecheck:board-pane', script: 'typecheck:board-pane' },
  { id: 'typecheck:shared', script: 'typecheck:shared' },
  { id: 'typecheck:ui', script: 'typecheck:ui' },
  { id: 'typecheck:e2e', script: 'typecheck:e2e' },
  { id: 'typecheck:examples', script: 'typecheck:examples' },
];

export async function runTypecheckAggregate(options = {}) {
  return runLanesToCompletion({
    lanes: TYPECHECK_LANES,
    label: 'typecheck',
    ...options,
  });
}

if (invokedDirectly(import.meta.url)) {
  const ok = await runTypecheckAggregate();
  if (!ok) process.exitCode = 1;
}
