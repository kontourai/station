#!/usr/bin/env node
// Decides whether a red PR Gallery capture is the pull request's doing or a
// break that is already on main. The PR check captures the pull request
// merged into the current base (gallery-pr-check.yml), so once a break lands
// every gallery-relevant pull request composes it; this is how they say so
// instead of each going red for someone else's change.
//
//   node scripts/gallery-main-attribution.mjs plan    --gallery=<dir> --allowlist=<file> --base-root=<dir> --out=<plan.json> [--max=<n>]
//   node scripts/gallery-main-attribution.mjs compare --plan=<plan.json> --base-root=<dir> --base-sha=<sha> [--summary=<file>]
//
// `plan` judges the composed capture and prints `screens=<a,b>`: the failing
// screens to capture again on the bare base. It prints
// `unattributable=<reason>` when that cannot settle it: no screen-level
// failure (a crash, or a test-level assertion), a failing screen main does
// not have, or more than --max failing screens (default 40, about four
// minutes of capture).
//
// `compare` judges the base's targeted capture of exactly those screens and
// prints `verdict=main` only when every composed failure (screen plus finding
// identity) also fails on the base; anything else is `verdict=pr`.
//
// Both judge with the copy of scripts/gallery-ui-findings.mjs that sits next
// to this file. The workflow runs this file from a worktree of the base
// commit, so the candidate's tree supplies the captures and its own
// allowlist but never the rule that excuses them. Exit 2 is a usage or input
// error, never a verdict; the workflow treats it as `verdict=pr`.
import {
  appendFileSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge, readAllowlist } from './gallery-ui-findings.mjs';

export const DEFAULT_MAX_SCREENS = 40;
const SCREEN_MAP = 'tests/gallery-screen-sources.json';
const ALLOWLIST = 'tests/gallery-ui-findings.allowlist.json';
const SHA = /^[0-9a-f]{40}$/;

function parseArgs(argv) {
  const [mode, ...flags] = argv;
  if (mode !== 'plan' && mode !== 'compare')
    throw new Error('usage: gallery-main-attribution.mjs plan|compare --...');
  const options = { mode, max: DEFAULT_MAX_SCREENS };
  for (const flag of flags) {
    const match = /^--([a-z-]+)=(.*)$/.exec(flag);
    if (!match) throw new Error(`unknown argument ${flag}`);
    const [, key, value] = match;
    if (key === 'max') {
      if (!/^[1-9][0-9]*$/.test(value))
        throw new Error('--max must be a positive integer');
      options.max = Number(value);
    } else if (
      [
        'gallery',
        'allowlist',
        'base-root',
        'out',
        'plan',
        'base-sha',
        'summary',
      ].includes(key)
    )
      options[key] = value;
    else throw new Error(`unknown argument --${key}`);
  }
  const required =
    mode === 'plan'
      ? ['gallery', 'allowlist', 'base-root', 'out']
      : ['plan', 'base-root', 'base-sha'];
  for (const key of required)
    if (!options[key]) throw new Error(`${mode} requires --${key}`);
  if (mode === 'compare' && !SHA.test(options['base-sha']))
    throw new Error('--base-sha must be a full lowercase commit id');
  return options;
}

function readCapture(dir) {
  const capture = JSON.parse(readFileSync(join(dir, 'capture.json'), 'utf8'));
  if (!Array.isArray(capture?.screens))
    throw new Error(`${dir}/capture.json has no screens array`);
  return capture;
}

const key = ({ screen, identity }) => `${screen}\u0000${identity}`;

/**
 * What to capture again on the base, from the composed capture's verdict.
 * Pure: `baseScreens` is the base's declared screen list.
 */
export function planAttribution(failures, baseScreens, max) {
  const screens = [...new Set(failures.map(({ screen }) => screen))].sort();
  if (screens.length === 0)
    return {
      reason:
        'the capture failed without a failing screen (a crash or a test-level assertion)',
    };
  const known = new Set(baseScreens);
  const absent = screens.filter((name) => !known.has(name));
  if (absent.length > 0)
    return { reason: `main has no screen named ${absent.join(', ')}` };
  if (screens.length > max)
    return {
      reason: `${screens.length} failing screens exceed the attribution bound of ${max}`,
    };
  return { screens };
}

/**
 * `main` only when every composed failure also fails, with the same finding
 * identity, on the base's capture of the same screens.
 */
export function compareAttribution(failures, baseFailures) {
  const onBase = new Set(baseFailures.map(key));
  const alsoOnMain = failures.filter((failure) => onBase.has(key(failure)));
  const introduced = failures.filter((failure) => !onBase.has(key(failure)));
  return {
    verdict: failures.length > 0 && introduced.length === 0 ? 'main' : 'pr',
    alsoOnMain,
    introduced,
  };
}

const listFailures = (failures) =>
  failures.map(({ screen, identity }) => `${screen}: ${identity}`);

function runPlan(options) {
  const verdict = judge(
    readCapture(options.gallery),
    readAllowlist(options.allowlist),
  );
  const failures = verdict.failures.map(({ screen, identity }) => ({
    screen,
    identity,
  }));
  const map = JSON.parse(
    readFileSync(join(options['base-root'], SCREEN_MAP), 'utf8'),
  );
  const plan = planAttribution(
    failures,
    Object.keys(map?.screens ?? {}),
    options.max,
  );
  writeFileSync(
    options.out,
    `${JSON.stringify({ failures, screens: plan.screens ?? null }, null, 2)}\n`,
  );
  console.log(
    plan.screens
      ? `screens=${plan.screens.join(',')}`
      : `unattributable=${plan.reason}`,
  );
  return 0;
}

function runCompare(options) {
  const plan = JSON.parse(readFileSync(options.plan, 'utf8'));
  if (!Array.isArray(plan?.screens) || plan.screens.length === 0)
    throw new Error(`${options.plan} names no screens to compare`);
  const base = readCapture(join(options['base-root'], 'gallery'));
  // The base capture must be exactly the requested subset: a full or
  // different capture is not evidence about these screens.
  const selection = Array.isArray(base.selection)
    ? [...base.selection].sort()
    : null;
  if (JSON.stringify(selection) !== JSON.stringify([...plan.screens].sort()))
    throw new Error(
      `the base capture's selection ${JSON.stringify(base.selection)} is not the requested ${plan.screens.join(',')}`,
    );
  const baseVerdict = judge(
    base,
    readAllowlist(join(options['base-root'], ALLOWLIST)),
    plan.screens,
  );
  const result = compareAttribution(plan.failures, baseVerdict.failures);
  const sha = options['base-sha'];
  const lines =
    result.verdict === 'main'
      ? [
          `Every Gallery failure here also fails on main at ${sha}; this pull request, merged into that main, introduces none.`,
          ...listFailures(result.alsoOnMain).map(
            (line) => `ALSO ON MAIN ${line}`,
          ),
        ]
      : [
          `This pull request, merged into main at ${sha}, introduces ${result.introduced.length} Gallery failure(s) that main does not have.`,
          ...listFailures(result.introduced).map(
            (line) => `INTRODUCED ${line}`,
          ),
          ...listFailures(result.alsoOnMain).map(
            (line) => `ALSO ON MAIN ${line}`,
          ),
        ];
  if (result.verdict === 'main')
    console.log(
      `::warning title=Gallery failure already on main::${result.alsoOnMain.length} failure(s) also fail on main at ${sha}: ${listFailures(result.alsoOnMain).join('; ')}`,
    );
  for (const line of lines) console.log(line);
  if (options.summary)
    appendFileSync(
      options.summary,
      `\n### Gallery failure attribution\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`,
    );
  console.log(`verdict=${result.verdict}`);
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    return options.mode === 'plan' ? runPlan(options) : runCompare(options);
  } catch (error) {
    console.error(
      `gallery-main-attribution: ${error instanceof Error ? error.message : error}`,
    );
    return 2;
  }
}

let isMain = false;
try {
  isMain =
    realpathSync(resolve(process.argv[1] ?? '')) ===
    realpathSync(fileURLToPath(import.meta.url));
} catch {
  // A missing entry path cannot be this module's executable invocation.
}
if (isMain) process.exitCode = main();
