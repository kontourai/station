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
// `unattributable=<reason>` when that cannot settle it: a capture that is
// not complete (a targeted selection, or fewer screens than it expected), no
// screen-level failure (a crash, or a test-level assertion), a failing
// screen main does not have, or more than --max failing screens (default 40,
// about four minutes of capture). The plan file also lists the screens that
// rendered and passed, so the workflow can still run the comparison's
// integrity checks over them.
//
// `compare` judges the base's targeted capture of exactly those screens and
// prints `verdict=main` only when every composed failure also fails on the
// base the same way; anything else is `verdict=pr`. "The same way" is the
// screen plus the finding identity, and for a screen that did not render or
// whose audit threw (identities `capture-failed`, `audit-error`,
// `audit-missing`, which are constants) also its normalised error text; see
// normaliseFailureDetail for exactly what is treated as volatile.
//
// Both judge with the copy of scripts/gallery-ui-findings.mjs that sits next
// to this file. The workflow runs this file from a worktree of the base
// commit, so the candidate's tree supplies the captures and its own
// allowlist but never the rule that excuses them. Exit 2 is a usage or input
// error, never a verdict; the workflow treats it as `verdict=pr`.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { judge, readAllowlist } from './gallery-ui-findings.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

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

/** The judge's constant identities for a screen it could not judge. */
const UNUSABLE_IDENTITIES = new Set([
  'capture-failed',
  'audit-error',
  'audit-missing',
]);

/**
 * The comparable part of an unusable screen's error. Removed or masked, as
 * volatile between two builds of the same failure: ANSI colour codes; the
 * `Browser errors: [...]` line the capture appends (console output carries
 * bundle hashes and stack positions that differ between any two builds, and
 * console errors never fail a screen on their own); a Playwright `Call log:`
 * and everything after it (retry attempts, timings, element snapshots);
 * loopback URLs' ports; absolute filesystem paths under runner, temp and
 * home roots; and the numbers on `Received...:` lines (a measurement).
 * Everything else is compared verbatim, including the assertion message,
 * matcher, `Expected` bound, locator and timeout bound, so a different
 * assertion, a timeout versus an assertion, or a different bound is a
 * different failure. When in doubt, two errors are not the same.
 */
export function normaliseFailureDetail(detail) {
  let text = String(detail ?? '').replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are the input.
    /\u001b\[[0-9;?]*[ -/]*[@-~]/g,
    '',
  );
  const callLog = text.search(/^\s*Call log:/m);
  if (callLog >= 0) text = text.slice(0, callLog);
  return text
    .split('\n')
    .filter((line) => !line.startsWith('Browser errors: '))
    .map((line) =>
      line
        .replace(
          /\b(https?|wss?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+/g,
          '$1://$2:<port>',
        )
        .replace(
          /(?:[A-Za-z]:)?\/(?:__w|home|Users|tmp|private|var|opt|root|runner|github|ms-playwright)\/[^\s'"`(),[\]]*/g,
          '<path>',
        ),
    )
    .map((line) =>
      /^\s*Received(?: [a-z]+)?:/.test(line)
        ? line.replace(/-?\d+(?:\.\d+)?/g, '<n>')
        : line,
    )
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/** A judge failure reduced to what compare matches on. */
export function failureKey({ screen, identity, detail }) {
  return {
    screen,
    identity,
    signature: UNUSABLE_IDENTITIES.has(identity)
      ? normaliseFailureDetail(detail)
      : '',
  };
}

const key = ({ screen, identity, signature }) =>
  `${screen}\u0000${identity}\u0000${signature ?? ''}`;

/**
 * Why a composed capture cannot support an excuse, or null when it is a
 * complete full run: every declared screen recorded, no targeted selection.
 */
export function incompleteCapture(capture) {
  if (capture.selection !== null)
    return `the capture is a targeted run (selection: ${JSON.stringify(capture.selection)})`;
  if (
    !Number.isInteger(capture.expected) ||
    capture.expected < 1 ||
    capture.screens.length !== capture.expected
  )
    return `the capture recorded ${capture.screens.length} of ${JSON.stringify(capture.expected)} expected screens`;
  return null;
}

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
 * identity and normalised error, on the base's capture of the same screens.
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
  failures.map(
    ({ screen, identity, signature }) =>
      `${screen}: ${identity}${signature ? ` (${signature.split('\n')[0]})` : ''}`,
  );

function runPlan(options) {
  const capture = readCapture(options.gallery);
  const verdict = judge(capture, readAllowlist(options.allowlist));
  const failures = verdict.failures.map(failureKey);
  const map = JSON.parse(
    readFileSync(join(options['base-root'], SCREEN_MAP), 'utf8'),
  );
  const incomplete = incompleteCapture(capture);
  const plan = incomplete
    ? { reason: incomplete }
    : planAttribution(failures, Object.keys(map?.screens ?? {}), options.max);
  const failing = new Set(failures.map(({ screen }) => screen));
  const passing = capture.screens
    .map(({ name }) => name)
    .filter((name) => !failing.has(name))
    .sort();
  writeFileSync(
    options.out,
    `${JSON.stringify({ failures, screens: plan.screens ?? null, passing }, null, 2)}\n`,
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
  const result = compareAttribution(
    plan.failures,
    baseVerdict.failures.map(failureKey),
  );
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

function main(argv = process.argv.slice(2)) {
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

if (invokedDirectly(import.meta.url)) process.exitCode = main();
