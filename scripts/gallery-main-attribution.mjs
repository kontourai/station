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
// base the same way. When the failures main does not have are all lazy chunk
// downloads (chunkLoadFailure), it prints `verdict=infrastructure`: the job
// stays red, but names chunk delivery rather than the pull request's layout.
// Anything else is `verdict=pr`. "The same way" is the
// screen plus the finding identity, and for a screen that did not render or
// whose audit threw (identities `capture-failed`, `audit-error`,
// `audit-missing`, which are constants) also its normalised error text; see
// normaliseFailureDetail for exactly what is treated as volatile.
//
// Both judge with the copy of scripts/gallery-ui-findings.mjs that sits next
// to this file. The workflow runs this file from a worktree of the base
// commit, so for an honest pull request the candidate's tree supplies the
// captures and its own allowlist but not the rule that excuses them. That is
// not a security boundary: the candidate's code has already run on the same
// runner, and the PR Gallery conclusion is not trusted by anything (see
// gallery-pr-check.yml). Exit 2 is a usage or input error, never a verdict;
// the workflow treats it as `verdict=pr`.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

/** The line tests/screenshots.spec.ts appends to a render failure's error. */
const APPENDED_CONSOLE_LINE = /\nBrowser errors: \[.*\]$/;

/**
 * The comparable part of an unusable screen's error, or null when the error
 * is not a string (never equal to anything). Treated as volatile between two
 * builds of the same failure, and nothing else:
 * - ANSI colour codes are removed;
 * - for a render failure, the LAST line when it is the capture's appended
 *   `Browser errors: [...]` (console output carries bundle hashes and ports
 *   that differ between any two builds, and never fails a screen on its own);
 *   the same text anywhere else is kept, so an error whose own message
 *   embeds console output is never excused.
 *   A message whose own last line is `Browser errors: [...]` cannot be told
 *   from the appended one; no current message ends that way;
 * - in a Playwright `Call log:`, every line after the first entry (retry
 *   attempts, `N ×` counters, `waiting 20ms`, element snapshots). The header
 *   and the first entry are kept: in Playwright 1.65 that entry names the
 *   target (`- waiting for <locator>[ to be <state>]`, `- navigating to
 *   "<url>", waiting until "<event>"`, or for expect `- Expect "<matcher>"
 *   <locator> with timeout <n>ms`) and carries no elapsed time or counter.
 *   A message that is nothing but a call log is kept whole;
 * - loopback URLs' ports become `<port>`;
 * - the checkout root (`root`) becomes `<repo>` where a path starts (line
 *   start, whitespace, quote or bracket), so the repo-relative path and its
 *   `:line:col` are still compared, and URL paths are untouched;
 * - a `Received...:` line whose whole value is a plain number becomes
 *   `Received...: <n>`. That covers measurements (toBeLessThanOrEqual) and
 *   equality matchers alike (toBe, toHaveCount, `Received length:`): main
 *   and the PR failing the SAME assertion with different actual numbers
 *   compare equal. Quoted, structured or mixed values, and every `Expected`
 *   line, are compared exactly.
 * An error that is empty after all of this never matches (failureKey).
 * Everything else is compared verbatim: the assertion message, matcher,
 * `Expected` bound, locator, timeout bound, routes and other paths. When in
 * doubt, two errors are not the same.
 */
export function normaliseFailureDetail(detail, { root, appendedConsole } = {}) {
  if (typeof detail !== 'string') return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are the input.
  let text = detail.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
  if (appendedConsole) text = text.replace(APPENDED_CONSOLE_LINE, '');
  const callLog = text.search(/^[ \t]*Call log:/m);
  if (callLog > 0 && text.slice(0, callLog).trim() !== '') {
    const [header, ...entries] = text.slice(callLog).split('\n');
    const first = entries.find((line) => line.trim() !== '');
    text = `${text.slice(0, callLog)}${header}${first === undefined ? '' : `\n${first}`}`;
  }
  const rootPattern = root
    ? new RegExp(
        `(^|[\\s'"\`(\\[])${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/+$/, '')}(?=/)`,
        'g',
      )
    : null;
  return text
    .split('\n')
    .map((line) => {
      let next = line.replace(
        /\b(https?|wss?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+/g,
        '$1://$2:<port>',
      );
      if (rootPattern) next = next.replace(rootPattern, '$1<repo>');
      return next.replace(
        /^(\s*Received(?: [a-z]+)?:)\s*-?\d+(?:\.\d+)?\s*$/,
        '$1 <n>',
      );
    })
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/**
 * A judge failure reduced to what compare matches on. An unusable screen's
 * signature is null, and so never matches, when its error is not text or
 * normalises to nothing: with nothing to compare, it is the PR's failure.
 * The empty signature of every other identity means "the identity alone".
 */
function failureKey({ screen, identity, detail }, root) {
  if (!UNUSABLE_IDENTITIES.has(identity))
    return { screen, identity, signature: '' };
  const signature = normaliseFailureDetail(detail, {
    root,
    appendedConsole: identity === 'capture-failed',
  });
  if (signature === null)
    return { screen, identity, signature, unmatchable: 'error is not text' };
  if (signature === '')
    return {
      screen,
      identity,
      signature: null,
      unmatchable: 'error is empty',
    };
  return { screen, identity, signature };
}

// A null signature (an empty or non-text error) matches nothing.
const key = ({ screen, identity, signature }) =>
  signature === null
    ? null
    : `${screen}\u0000${identity}\u0000${signature ?? ''}`;

/**
 * Why a composed capture cannot support an excuse, or null when it is a
 * complete full run: every declared screen recorded, no targeted selection.
 */
function incompleteCapture(capture) {
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
 * The identity line tests/screenshots.spec.ts leads a screen's error with when
 * the screen showed an app error surface AND an app chunk request of the live
 * document failed (tests/helpers/gallery-app-error-state.ts,
 * formatAppErrorIdentity). A surface with `no failed chunk request` (a render
 * error, a chunk that downloaded and threw) does not match.
 */
const CHUNK_LOAD_IDENTITY =
  /^app-error-surface: [a-z, -]+; failed chunk requests: \S/;

/**
 * Whether a composed failure is a lazy chunk that failed to download: the
 * capture's own app-error identity, never a layout finding (the capture does
 * not audit that state). The capture captures such a screen once more while
 * its run budget lasts, so reaching here means it failed again or the budget
 * was spent.
 */
function chunkLoadFailure({ identity, signature }) {
  return (
    identity === 'capture-failed' &&
    typeof signature === 'string' &&
    CHUNK_LOAD_IDENTITY.test(signature.split('\n')[0])
  );
}

/**
 * `main` only when every composed failure also fails, with the same finding
 * identity and normalised error, on the base's capture of the same screens.
 * `infrastructure` when main does not have some of them but every one it does
 * not have is a chunk download failure: still a failure, attributed to chunk
 * delivery rather than to the pull request's layout. Otherwise `pr`.
 */
export function compareAttribution(failures, baseFailures) {
  const onBase = new Set(baseFailures.map(key).filter((k) => k !== null));
  const alsoOnMain = failures.filter((failure) => onBase.has(key(failure)));
  const introduced = failures.filter((failure) => !onBase.has(key(failure)));
  let verdict = 'pr';
  if (failures.length > 0 && introduced.length === 0) verdict = 'main';
  else if (introduced.length > 0 && introduced.every(chunkLoadFailure))
    verdict = 'infrastructure';
  return { verdict, alsoOnMain, introduced };
}

const MAX_SHOWN = 160;
const bounded = (text) =>
  text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN - 1)}…` : text;

const listFailures = (failures) =>
  failures.map(
    ({ screen, identity, signature }) =>
      `${screen}: ${identity}${signature ? ` (${bounded(signature.split('\n')[0])})` : ''}`,
  );

/**
 * An introduced failure, with the first line where its error differs from
 * main's failure of the same screen and identity, when main has one.
 */
function describeIntroduced(failure, baseFailures) {
  const label = `${failure.screen}: ${failure.identity}`;
  if (failure.signature === null)
    return `${label} (${failure.unmatchable ?? 'error is not comparable'})`;
  if (!failure.signature) return label;
  const onMain = baseFailures.find(
    ({ screen, identity }) =>
      screen === failure.screen && identity === failure.identity,
  );
  const ours = failure.signature.split('\n');
  if (!onMain || typeof onMain.signature !== 'string')
    return `${label} (${bounded(ours[0])})`;
  const theirs = onMain.signature.split('\n');
  const at = ours.findIndex((line, index) => line !== theirs[index]);
  const index = at < 0 ? ours.length : at;
  return `${label} (line ${index + 1}: ${bounded(ours[index] ?? '<end>')} | main: ${bounded(theirs[index] ?? '<end>')})`;
}

function runPlan(options) {
  const capture = readCapture(options.gallery);
  const verdict = judge(capture, readAllowlist(options.allowlist));
  const root = resolve(dirname(options.gallery));
  const failures = verdict.failures.map((failure) => failureKey(failure, root));
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
  const root = resolve(options['base-root']);
  const baseFailures = baseVerdict.failures.map((failure) =>
    failureKey(failure, root),
  );
  const result = compareAttribution(plan.failures, baseFailures);
  const sha = options['base-sha'];
  const lines =
    result.verdict === 'infrastructure'
      ? [
          `Main at ${sha} captured these screens cleanly, and every failure here that main does not have is a lazy chunk that failed to download (the capture already captured each such screen once more while its second-capture budget lasted); no layout was judged for those screens. Attributed to chunk delivery, not to this pull request's layout. If the same chunk fails again on a re-run, suspect this pull request's change to that chunk.`,
          ...listFailures(result.introduced).map(
            (line) => `CHUNK LOAD ${line}`,
          ),
          ...listFailures(result.alsoOnMain).map(
            (line) => `ALSO ON MAIN ${line}`,
          ),
        ]
      : result.verdict === 'main'
        ? [
            `Every Gallery failure here also fails on main at ${sha}; this pull request, merged into that main, introduces none.`,
            ...listFailures(result.alsoOnMain).map(
              (line) => `ALSO ON MAIN ${line}`,
            ),
          ]
        : [
            `This pull request, merged into main at ${sha}, introduces ${result.introduced.length} Gallery failure(s) that main does not have.`,
            ...result.introduced.map(
              (failure) =>
                `INTRODUCED ${describeIntroduced(failure, baseFailures)}`,
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
