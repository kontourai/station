/**
 * Accessibility ratchet (mirrors state-primitives-ratchet.mjs / shell-conformance-ratchet.mjs).
 *
 * Biome's whole `a11y` rule family was disabled in biome.json, so `biome check`
 * reported a clean tree while 710 real violations sat behind the switch. Every
 * a11y rule that is already clean should be an *error* (a free permanent
 * ratchet); the thirteen rules that carry a backlog run as warnings, and this
 * gate keeps that backlog falling.
 *
 * Deliberately NOT fixed by bulk edit: `useButtonType` accounts for 296 of the
 * violations, but every `<button>` inside a `<form>` already carries an explicit
 * type — verified 2026-07-25. The remaining ones are outside forms, where the
 * implicit `submit` default does nothing, so rewriting them would be ~296 inert
 * edits. Fix them as the surrounding components are touched instead.
 *
 * Self-activating: while `a11y.recommended` is not `true` in biome.json this
 * reports inactive and exits 0, so wiring it into the gate can never fail for a
 * reason the reader cannot act on.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, 'scripts/a11y-baseline.json');
const BIOME_CONFIG_PATH = join(ROOT, 'biome.json');

/**
 * Must stay in step with the `lint:check` script in package.json.
 *
 * Explicit source roots rather than `.`: linting the whole repo also reaches
 * generated output (`src-desktop/gen/`), signed in-toto attestations under
 * `delivery/`, and Veritas Protected Standards — all of which the formatter
 * will happily rewrite.
 */
const SOURCE_ROOTS = [
  'src-server/',
  'src-ui/',
  'packages/',
  'scripts/',
  'tests/',
  'examples/',
  'src-shared/',
];

/** Is the a11y family switched on in the repo's biome config? */
export function a11yEnabled(configText) {
  try {
    const config = JSON.parse(configText);
    return config?.linter?.rules?.a11y?.recommended === true;
  } catch {
    return false;
  }
}

/** Count `lint/a11y/<rule>` diagnostics per rule in biome's output. */
export function countViolations(biomeOutput) {
  const counts = {};
  for (const match of biomeOutput.matchAll(/lint\/a11y\/([A-Za-z]+)/g)) {
    counts[match[1]] = (counts[match[1]] ?? 0) + 1;
  }
  return counts;
}

/**
 * Compare measured counts against the baseline ceilings.
 *
 * A rule missing from `measured` counts as zero — reaching zero is the goal, so
 * it must never read as "unmeasured" and pass silently.
 */
export function evaluate(measured, baseline) {
  const regressions = [];
  const improvements = [];

  for (const [rule, ceiling] of Object.entries(baseline.ceilings)) {
    const actual = measured[rule] ?? 0;
    if (actual > ceiling) regressions.push({ rule, actual, ceiling });
    else if (actual < ceiling) improvements.push({ rule, actual, ceiling });
  }

  // A rule with violations but no ceiling is a newly-enabled rule regressing.
  for (const [rule, actual] of Object.entries(measured)) {
    if (!(rule in baseline.ceilings) && actual > 0) {
      regressions.push({ rule, actual, ceiling: 0 });
    }
  }

  return { regressions, improvements };
}

/**
 * Biome writes its summary to stdout but its diagnostics to stderr, and exits
 * 0 when everything it found was a warning. Capturing only stdout — or only the
 * throwing path — measures an empty string and silently reports a clean tree.
 * Always merge both streams, on both paths.
 */
function runBiome() {
  // spawnSync rather than execFileSync: execFileSync only hands back stderr on
  // the throwing path, so a run that exits 0 with warnings loses every
  // diagnostic and measures as a clean tree.
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['biome', 'lint', '--max-diagnostics=5000', ...SOURCE_ROOTS],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.error) {
    throw new Error(`failed to run biome: ${result.error.message}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/**
 * Guard against measuring nothing. Biome always prints a `Checked N files`
 * summary; its absence means the run did not happen, and a ratchet that cannot
 * measure must fail rather than report a clean tree.
 */
export function assertMeasurable(output) {
  if (!/Checked \d+ files?/.test(output)) {
    throw new Error(
      'biome produced no "Checked N files" summary — the lint run did not ' +
        'complete, so violation counts cannot be trusted.',
    );
  }
  return output;
}

function main() {
  const args = process.argv.slice(2);
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

  console.log(
    '\nAccessibility ratchet (a11y violation counts must only decrease).',
  );

  if (!a11yEnabled(readFileSync(BIOME_CONFIG_PATH, 'utf8'))) {
    console.log(
      'INACTIVE: biome.json does not set linter.rules.a11y.recommended = true, so no\n' +
        'a11y diagnostics are produced and there is nothing to ratchet. Enable the family\n' +
        `(see ${BASELINE_PATH.replace(`${ROOT}/`, '')} for the recorded ceilings) to activate this gate.`,
    );
    return;
  }

  const measured = countViolations(assertMeasurable(runBiome()));
  const { regressions, improvements } = evaluate(measured, baseline);
  const total = Object.values(measured).reduce((sum, n) => sum + n, 0);

  if (args.includes('--update')) {
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify({ ...baseline, ceilings: measured, total }, null, 2)}\n`,
    );
    console.log(`Baseline rewritten: ${total} violation(s).`);
    return;
  }

  for (const { rule, actual, ceiling } of improvements) {
    console.log(`  improved: ${rule} ${ceiling} -> ${actual}`);
  }

  if (regressions.length > 0) {
    console.error('\nFAIL: accessibility violations increased.');
    for (const { rule, actual, ceiling } of regressions) {
      console.error(`  ${rule}: ${actual} > ceiling ${ceiling}`);
    }
    console.error(
      '\nFix the new violations, or run `node scripts/a11y-ratchet.mjs --update`\n' +
        'only when lowering a ceiling.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `OK: ${total} violation(s), none above ceiling` +
      (improvements.length > 0
        ? `; ${improvements.length} rule(s) improved — run --update to lower the ceilings.`
        : '.'),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
