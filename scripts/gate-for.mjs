#!/usr/bin/env node
// Answers "which gates does MY change surface feed, and what should I run?"
// by composing the scope deciders the pre-push checks already export. This
// script re-encodes no path lists of its own, so it cannot drift from the
// gates it describes — each decider is the exact one .githooks/pre-push runs.
//
//   npm run gate:for                                  # changed vs origin/main
//   npm run gate:for -- --base=origin/release
//   npm run gate:for -- src-ui/src/App.tsx docs/x.md  # hypothetical paths
//
// With explicit paths the surfaces are evaluated as-is, which answers the
// question BEFORE writing anything. The output is a report plus matching
// Veritas guidance. It runs no evidence checks and exits 2 when the edit scope
// or required governance context cannot be read.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  buildExplainGuidance,
  loadRepoMap,
  loadRepoStandards,
} from '@kontourai/veritas';
import { decideOrchestrationTransferScope } from './check-prepush-orchestration-transfer.mjs';
import { decideSdkBarrelScope } from './check-prepush-sdk-barrel.mjs';
import { decideStaticGateScope } from './check-prepush-static-gates.mjs';
import { decideTypecheckScope } from './check-prepush-typecheck.mjs';
import {
  collectDocumentationChanges,
  formatDocumentationImpact,
  readDocumentationImpact,
} from './documentation-impact.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { fixturePolicyCommands } from './test-fixture-policy.mjs';

function resolveBaseSha(base) {
  try {
    return execFileSync('git', ['rev-parse', base], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

/** Unscoped commands in the hook's normal source-edit push path. */
export const EVERY_PUSH_CHECKS = Object.freeze([
  Object.freeze({
    command: 'npm run lint:check',
    note: 'biome lint/format/imports',
  }),
  Object.freeze({
    command: 'npm run proof:repo-governance',
    note: 'governance proof (~4s)',
  }),
  Object.freeze({
    command: 'node scripts/prepush-pure-merge.mjs',
    note: 'classifies actual pushed refs against remote main (#3101)',
  }),
  Object.freeze({
    command: 'npm run veritas:readiness',
    note: 'Veritas readiness; pure merges defer this check to required CI',
  }),
  Object.freeze({
    command: 'node scripts/commit-message-gate.mjs --prepush-stdin',
    note: 'commit subjects in the push range',
  }),
]);

/** The verification ladder, cheapest first; `command` is null off-host. */
export const LANE_LADDER = Object.freeze([
  Object.freeze({
    stage: 'Tests — derive the focused selection (do not guess)',
    command: 'npm run test:changed -- --base=origin/main --explain',
    detail: null,
  }),
  Object.freeze({
    stage: 'Bounded feedback before push',
    command: 'npm run ci:fast',
    detail: null,
  }),
  Object.freeze({
    stage: 'Ordinary PR integration',
    command: null,
    detail: 'required checks on the GitHub merge queue candidate',
  }),
  Object.freeze({
    stage: 'Promotion completion',
    command: 'npm run full:regression',
    detail: 'hosted Nightly/tag workflow runs',
  }),
  Object.freeze({
    stage: 'Explicit diagnostic escape hatch',
    command: null,
    detail: 'manual PR: CI workflow_dispatch',
  }),
]);

/**
 * The pre-push gates scoped to this change surface, each with its own
 * decider's verdict and reason. A pure consumer of the hook's deciders, so
 * this cannot drift from what the hook actually runs.
 *
 * @returns {{ name: string, runs: boolean, reason: string, command: string }[]}
 */
export function gateScopes({ changedPaths, baseSha }) {
  const statics = decideStaticGateScope({ baseSha, changedPaths });
  const barrel = decideSdkBarrelScope({ baseSha, changedPaths });
  const transfer = decideOrchestrationTransferScope({ baseSha, changedPaths });
  const typecheck = decideTypecheckScope({ baseSha, changedPaths });
  return [
    {
      name: 'orchestration transfer budgets',
      decision: transfer,
      command: 'node scripts/check-prepush-orchestration-transfer.mjs',
    },
    {
      name: 'static gates (UI contracts, content)',
      decision: statics,
      command: 'node scripts/check-prepush-static-gates.mjs',
    },
    {
      name: 'SDK public barrel',
      decision: barrel,
      command: 'node scripts/check-prepush-sdk-barrel.mjs',
    },
    {
      name: 'typecheck (twelve tsc lanes, ~91s)',
      decision: typecheck,
      command: 'node scripts/check-prepush-typecheck.mjs',
    },
  ].map(({ name, decision, command }) => ({
    name,
    runs: decision.run,
    reason: decision.reason,
    command,
  }));
}

/** Everything the report says, as data (`npm run gate:for -- --json`). */
export function gatePlan({ changedPaths, baseSha }) {
  return {
    changedPaths: [...changedPaths],
    everyPush: EVERY_PUSH_CHECKS,
    scoped: gateScopes({ changedPaths, baseSha }),
    fixtureCommands: fixturePolicyCommands(changedPaths),
    ladder: LANE_LADDER,
  };
}

export function gateReport({ changedPaths, baseSha }) {
  const plan = gatePlan({ changedPaths, baseSha });
  const lines = [
    `gate:for — ${plan.changedPaths.length} changed path(s)`,
    '',
    'Normal source-edit push (armed in .githooks/pre-push):',
    ...plan.everyPush.map(
      ({ command, note }) => `  ${command.padEnd(46)} # ${note}`,
    ),
    '',
    'The hook classifies pure merges from actual push refs; only verified clean merges take its lighter path.',
    '',
    'Scoped to this change surface:',
  ];
  for (const { name, runs, reason, command } of plan.scoped) {
    lines.push(`  ${runs ? 'RUNS   ' : 'skipped'} ${name}`);
    lines.push(`          ${reason}`);
    if (runs) lines.push(`          ${command}`);
  }
  if (plan.fixtureCommands.length)
    lines.push(
      '',
      'Fixture and test-effectiveness route:',
      ...plan.fixtureCommands.map((command) => `  ${command}`),
    );
  lines.push(
    '',
    ...plan.ladder.map(
      ({ stage, command, detail }) =>
        `${stage}:  ${[detail, command].filter(Boolean).join(' ')}`,
    ),
  );
  return lines.join('\n');
}

function addGuidanceRule(selected, rule, filePath) {
  const existing = selected.get(rule.id);
  if (existing) existing.paths.add(filePath);
  else selected.set(rule.id, { rule, paths: new Set([filePath]) });
}

function guidanceLinesForRule(rule) {
  const { paths } = rule;
  const lines = [
    `  ${rule.id} (${rule.enforcementLevel}) — ${paths.join(', ')}`,
    `    ${rule.summary}`,
  ];
  if (rule.evidenceCheckIds.length > 0)
    lines.push(`    Evidence checks: ${rule.evidenceCheckIds.join(', ')}`);
  for (const item of rule.mustDo) lines.push(`    Do: ${item}`);
  for (const item of rule.mustNotDo) lines.push(`    Do not: ${item}`);
  return lines;
}

/**
 * The Veritas rules that govern `changedPaths`, as data: each rule once,
 * with the paths it matched.
 */
export function veritasGuidanceRules(changedPaths, rootDir = process.cwd()) {
  if (changedPaths.length === 0) return [];
  const repoMap = loadRepoMap(resolve(rootDir, '.veritas/repo-map.json'));
  const repoStandards = loadRepoStandards(
    resolve(rootDir, '.veritas/repo-standards/default.repo-standards.json'),
  );
  const selected = new Map();
  for (const filePath of changedPaths) {
    const guidance = buildExplainGuidance({
      rootDir,
      repoMap,
      repoStandards,
      filePath,
    });
    for (const rule of guidance.rules)
      addGuidanceRule(selected, rule, filePath);
  }
  return [...selected.values()].map(({ rule, paths }) => ({
    id: rule.id,
    enforcementLevel: rule.enforcementLevel,
    summary: rule.summary,
    evidenceCheckIds: [...rule.evidenceCheckIds],
    mustDo: [...rule.mustDo],
    mustNotDo: [...rule.mustNotDo],
    paths: [...paths],
  }));
}

/** Present the exact Veritas path guidance during Station's required pre-edit route. */
export function veritasGuidanceForPaths(changedPaths, rootDir = process.cwd()) {
  if (changedPaths.length === 0)
    return 'Veritas guidance: no changed paths to brief.';
  const rules = veritasGuidanceRules(changedPaths, rootDir);
  if (rules.length === 0)
    return 'Veritas guidance: no matching rules for these paths.';
  return [
    'Veritas guidance for the intended paths:',
    ...rules.flatMap(guidanceLinesForRule),
  ].join('\n');
}

function writeBriefedReport(changedPaths, baseSha, mergeBase, { json }) {
  try {
    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ...gatePlan({ changedPaths, baseSha }),
            guidance: veritasGuidanceRules(changedPaths),
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    const guidance = veritasGuidanceForPaths(changedPaths);
    const documentation = formatDocumentationImpact(
      readDocumentationImpact({ changedPaths, mergeBase }),
    );
    process.stdout.write(
      `${gateReport({ changedPaths, baseSha })}\n\n${guidance}\n\n${documentation}\n`,
    );
  } catch (error) {
    console.error(
      `gate-for: path briefing failed: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 2;
  }
}

export function parseArgs(argv) {
  let base = 'origin/main';
  let json = false;
  const explicit = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--base=')) {
      base = arg.slice('--base='.length);
    } else if (arg === '--base') {
      i += 1;
      base = argv[i] ?? '';
    } else if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--')) {
      // A scoping advisor must never absorb a typo'd flag as a path and then
      // answer "nothing applies" about a surface it never looked at.
      throw new Error(
        `unrecognized flag: ${arg} (supported: --base=<ref>, --json)`,
      );
    } else {
      explicit.push(arg);
    }
  }
  if (!base) throw new Error('--base requires a ref');
  return { base, explicit, json };
}

export function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(
      `gate-for: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(2);
  }
  const { base, explicit, json } = parsed;
  if (explicit.length > 0) {
    // Explicit-paths mode never consults git: the caller supplied the scope,
    // so the deciders get a truthy sentinel instead of a resolved sha and the
    // verdict depends only on the paths given.
    writeBriefedReport(explicit, 'explicit-paths', undefined, { json });
    return;
  }
  const baseSha = resolveBaseSha(base);
  let changedPaths;
  let mergeBase;
  try {
    const selection = collectDocumentationChanges(process.cwd(), base);
    changedPaths = selection.paths;
    mergeBase = selection.mergeBase;
  } catch {
    // Fail OPEN like the deciders themselves: an unreadable diff means the
    // scope is unknown, and unknown scope reports every gate as applicable.
    changedPaths = [];
    console.error(
      'gate-for: changed paths are unavailable, so Veritas cannot brief the edit scope.',
    );
    process.stdout.write(
      json
        ? `${JSON.stringify(gatePlan({ changedPaths, baseSha: '' }), null, 2)}\n`
        : `${gateReport({ changedPaths, baseSha: '' })}\n`,
    );
    process.exitCode = 2;
    return;
  }
  writeBriefedReport(changedPaths, baseSha, mergeBase, { json });
}

if (invokedDirectly(import.meta.url)) {
  main();
}
