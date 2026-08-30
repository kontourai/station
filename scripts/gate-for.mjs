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
// question BEFORE writing anything. The output is a report, not a gate: it
// runs nothing and always exits 0 unless the repository itself is unreadable.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decideOrchestrationTransferScope } from './check-prepush-orchestration-transfer.mjs';
import {
  changedPathsSince,
  decideSdkBarrelScope,
} from './check-prepush-sdk-barrel.mjs';
import { decideStaticGateScope } from './check-prepush-static-gates.mjs';
import { decideBundleScope } from './check-prepush-ui-bundle.mjs';

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

export function gateReport({ changedPaths, baseSha }) {
  // Each decider names its verdict field differently (`measure` vs `run`);
  // read the field that decider actually returns rather than normalizing at
  // the source, so this stays a pure consumer of the hook's own functions.
  const bundle = decideBundleScope({ baseSha, changedPaths });
  const statics = decideStaticGateScope({ baseSha, changedPaths });
  const barrel = decideSdkBarrelScope({ baseSha, changedPaths });
  const transfer = decideOrchestrationTransferScope({ baseSha, changedPaths });
  const scoped = [
    [
      'UI entry-bundle ceiling',
      bundle.measure,
      bundle.reason,
      'node scripts/check-prepush-ui-bundle.mjs',
    ],
    [
      'orchestration transfer budgets',
      transfer.run,
      transfer.reason,
      'node scripts/check-prepush-orchestration-transfer.mjs',
    ],
    [
      'static gates (UI contracts, content)',
      statics.run,
      statics.reason,
      'node scripts/check-prepush-static-gates.mjs',
    ],
    [
      'SDK public barrel',
      barrel.run,
      barrel.reason,
      'node scripts/check-prepush-sdk-barrel.mjs',
    ],
  ];
  const lines = [
    `gate:for — ${changedPaths.length} changed path(s)`,
    '',
    'Every push (armed in .githooks/pre-push):',
    '  npm run lint:check                             # biome lint/format/imports',
    '  node scripts/commit-message-gate.mjs --prepush-stdin   # commit subjects in the push range',
    '',
    'Scoped to this change surface:',
  ];
  for (const [name, applies, reason, command] of scoped) {
    lines.push(`  ${applies ? 'RUNS   ' : 'skipped'} ${name}`);
    lines.push(`          ${reason}`);
    if (applies) lines.push(`          ${command}`);
  }
  lines.push(
    '',
    'Tests — derive the focused selection (do not guess):',
    '  npm run test:changed -- --base=origin/main --explain',
    'Bounded feedback before push:  npm run ci:fast',
    'Ordinary PR integration:  required checks on the GitHub merge queue candidate',
    'Promotion completion:  hosted Nightly/tag workflow runs npm run full:regression',
    'Explicit diagnostic escape hatch:  manual CI workflow_dispatch',
  );
  return lines.join('\n');
}

export function parseArgs(argv) {
  let base = 'origin/main';
  const explicit = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--base=')) {
      base = arg.slice('--base='.length);
    } else if (arg === '--base') {
      i += 1;
      base = argv[i] ?? '';
    } else if (arg.startsWith('--')) {
      // A scoping advisor must never absorb a typo'd flag as a path and then
      // answer "nothing applies" about a surface it never looked at.
      throw new Error(`unrecognized flag: ${arg} (supported: --base=<ref>)`);
    } else {
      explicit.push(arg);
    }
  }
  if (!base) throw new Error('--base requires a ref');
  return { base, explicit };
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
  const { base, explicit } = parsed;
  if (explicit.length > 0) {
    // Explicit-paths mode never consults git: the caller supplied the scope,
    // so the deciders get a truthy sentinel instead of a resolved sha and the
    // verdict depends only on the paths given.
    process.stdout.write(
      `${gateReport({ changedPaths: explicit, baseSha: 'explicit-paths' })}\n`,
    );
    return;
  }
  const baseSha = resolveBaseSha(base);
  let changedPaths;
  try {
    changedPaths = changedPathsSince(base);
  } catch {
    // Fail OPEN like the deciders themselves: an unreadable diff means the
    // scope is unknown, and unknown scope reports every gate as applicable.
    changedPaths = [];
    process.stdout.write(`${gateReport({ changedPaths, baseSha: '' })}\n`);
    return;
  }
  process.stdout.write(`${gateReport({ changedPaths, baseSha })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
