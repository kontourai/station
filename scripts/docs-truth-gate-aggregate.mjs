#!/usr/bin/env node
// Run all independent checks after a failure so one red lane cannot hide
// another (archive#4249). Each lane still owns its validation semantics.
import { invokedDirectly } from './lib/module-entry.mjs';
import { runLanesToCompletion } from './lib/npm-lane-aggregate.mjs';

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
