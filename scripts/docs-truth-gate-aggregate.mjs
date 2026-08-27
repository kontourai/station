#!/usr/bin/env node
/**
 * Run every independent `docs:truth:gate` check to completion and report
 * every failing one (station#4249 slice 2).
 *
 * `npm run docs:truth:gate` used to chain 12 independent repo-hygiene checks
 * with `&&`. The first failure ended the run: station#4249's motivating
 * incident died on `docs:index:check` (attempt #9 of twelve) with no way to
 * know whether `docs:links:check`, right behind it in the same chain, was
 * also red.
 *
 * Every check's own command is UNCHANGED -- this script only changes how many
 * of the 12 independent checks run per invocation, never what any one of them
 * inspects. The final biome check over the docs-tooling source files is
 * pulled out into its own named script, `docs:truth:biome`, purely so it has
 * an id to run uniformly alongside the other 11 npm-script checks; its
 * command text is byte-identical to what `docs:truth:gate` used to run last.
 */
import { invokedDirectly } from './lib/module-entry.mjs';
import { runLanesToCompletion } from './lib/npm-lane-aggregate.mjs';

/**
 * The same 12 independent checks `docs:truth:gate`'s old `&&` chain named, in
 * the same order, each pointing at the SAME unmodified npm script.
 */
export const DOCS_TRUTH_GATE_LANES = [
  { id: 'contribution:gate', script: 'contribution:gate' },
  { id: 'labels:check', script: 'labels:check' },
  { id: 'docs:issue-lifecycle:check', script: 'docs:issue-lifecycle:check' },
  {
    id: 'docs:contributor-commands:check',
    script: 'docs:contributor-commands:check',
  },
  { id: 'docs:public:hygiene', script: 'docs:public:hygiene' },
  { id: 'docs:hygiene:repo', script: 'docs:hygiene:repo' },
  { id: 'docs:index:check', script: 'docs:index:check' },
  { id: 'docs:cli-parity:check', script: 'docs:cli-parity:check' },
  {
    id: 'docs:public:contract-examples',
    script: 'docs:public:contract-examples',
  },
  { id: 'docs:foundations:test', script: 'docs:foundations:test' },
  { id: 'docs:links:check', script: 'docs:links:check' },
  { id: 'docs:truth:biome', script: 'docs:truth:biome' },
];

export async function runDocsTruthGateAggregate(options = {}) {
  return runLanesToCompletion({
    lanes: DOCS_TRUTH_GATE_LANES,
    label: 'docs:truth:gate',
    ...options,
  });
}

if (invokedDirectly(import.meta.url)) {
  const ok = await runDocsTruthGateAggregate();
  if (!ok) process.exitCode = 1;
}
