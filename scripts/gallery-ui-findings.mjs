#!/usr/bin/env node
// Judges the gallery's product assertions (hit targets, horizontal overflow,
// blocking axe) that tests/screenshots.spec.ts records per screen in
// `gallery/capture.json` under `uiAudit`, against the shrink-only allowlist.
//
//   node scripts/gallery-ui-findings.mjs check  [--gallery=<dir>] [--allowlist=<file>] [--screens=a,b] [--summary=<file>]
//   node scripts/gallery-ui-findings.mjs prune  [--gallery=<dir>] [--allowlist=<file>]
//   node scripts/gallery-ui-findings.mjs growth --base=<git-ref> [--allowlist=<file>]
//   node scripts/gallery-ui-findings.mjs seed   [--gallery=<dir>] [--allowlist=<file>]
//   node scripts/gallery-ui-findings.mjs adopt  --screens=a,b [--gallery=<dir>] [--allowlist=<file>]
//
// `check` fails (exit 1) on any finding the allowlist does not name for that
// screen, and on a captured screen whose audit is missing or threw. A
// listed finding that no longer occurs never fails; it is reported so
// `prune` can remove it. The allowlist is keyed by screen name plus finding
// identity (no line numbers, counts, or measurements), so it changes only
// when a finding appears or goes away. `growth` fails when the allowlist
// names any (screen, identity) pair its base revision did not, for a screen
// the base already had: existing screens only shrink. A screen absent from
// both the base allowlist and the base screen map
// (tests/gallery-screen-sources.mjs, which the capture pins to SCREENS) is
// new coverage, not a regression, and may arrive with its findings listed.
// `adopt` lists the current findings of screens the allowlist does not yet
// name; `growth` still refuses them unless the screens are new. `seed`
// writes the first allowlist and refuses once one exists.
// Exit 2 is a usage or input error, never a verdict.
//
// Self-contained (node built-ins only): the PR workflow runs the BASE
// revision's copy from a temp directory for `growth`, so a candidate cannot
// rewrite the rule that judges its own allowlist.
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_ALLOWLIST = 'tests/gallery-ui-findings.allowlist.json';
const SCREEN_SOURCES = 'tests/gallery-screen-sources.mjs';

class UsageError extends Error {}

export function parseArgs(argv) {
  // `check` is the default so `node scripts/gallery-ui-findings.mjs --screens=a`
  // reads naturally.
  const [mode, ...rest] =
    argv.length === 0 || argv[0].startsWith('--') ? ['check', ...argv] : argv;
  if (!Object.hasOwn(RUNNERS, mode))
    throw new UsageError(
      `first argument must be one of ${Object.keys(RUNNERS).join(', ')} (got ${mode ?? 'nothing'})`,
    );
  const options = { mode, gallery: 'gallery', allowlist: DEFAULT_ALLOWLIST };
  for (const arg of rest) {
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? '' : arg.slice(eq + 1);
    if (!value) throw new UsageError(`${flag} requires a value`);
    if (flag === '--gallery') options.gallery = value;
    else if (flag === '--allowlist') options.allowlist = value;
    else if (flag === '--summary') options.summary = value;
    else if (flag === '--base') options.base = value;
    else if (flag === '--screens')
      options.screens = value
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
    else throw new UsageError(`unrecognized option ${flag}`);
  }
  if (mode === 'growth' && !options.base)
    throw new UsageError('growth requires --base=<git-ref>');
  if (mode === 'adopt' && !options.screens)
    throw new UsageError('adopt requires --screens=<names>');
  return options;
}

function parseAllowlist(text, source) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${source} is not JSON: ${error.message}`);
  }
  if (
    parsed?.schemaVersion !== 1 ||
    typeof parsed.screens !== 'object' ||
    parsed.screens === null ||
    Object.values(parsed.screens).some(
      (ids) => !Array.isArray(ids) || ids.some((id) => typeof id !== 'string'),
    )
  )
    throw new UsageError(
      `${source} must be { schemaVersion: 1, screens: { <screen>: string[] } }`,
    );
  return parsed;
}

export function readAllowlist(path) {
  if (!existsSync(path)) throw new UsageError(`no allowlist at ${path}`);
  return parseAllowlist(readFileSync(path, 'utf8'), path);
}

function readCapture(gallery) {
  const path = join(gallery, 'capture.json');
  if (!existsSync(path)) throw new UsageError(`no capture manifest at ${path}`);
  const capture = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(capture?.screens))
    throw new UsageError(`${path} has no screens array`);
  return capture;
}

/** Why a captured screen cannot be judged, or null when its audit is usable. */
function unusableScreen(entry) {
  if (!entry.ok)
    return {
      identity: 'capture-failed',
      detail: entry.error ?? 'screen did not render',
    };
  const audit = entry.uiAudit;
  if (audit?.error) return { identity: 'audit-error', detail: audit.error };
  if (!Array.isArray(audit?.findings))
    return {
      identity: 'audit-missing',
      detail: 'capture.json carries no uiAudit for this screen',
    };
  return null;
}

function judgeScreen(name, entry, listedIdentities) {
  const unusable = unusableScreen(entry);
  if (unusable)
    return {
      failures: [{ screen: name, ...unusable }],
      resolved: [],
      count: 0,
    };
  const listed = new Set(listedIdentities);
  const seen = new Set(entry.uiAudit.findings.map(({ identity }) => identity));
  return {
    failures: entry.uiAudit.findings
      .filter(({ identity }) => !listed.has(identity))
      .map((finding) => ({ screen: name, ...finding })),
    resolved: [...listed]
      .filter((identity) => !seen.has(identity))
      .map((identity) => ({ screen: name, identity })),
    count: entry.uiAudit.findings.length,
  };
}

/**
 * The verdict, as data. `failures` are unlisted findings and unusable audits;
 * `resolved` are listed findings this capture no longer produces.
 */
export function judge(capture, allowlist, screens) {
  const captured = new Map(capture.screens.map((entry) => [entry.name, entry]));
  const unknown = (screens ?? []).filter((name) => !captured.has(name));
  if (unknown.length > 0)
    throw new UsageError(
      `--screens names screens this capture does not have: ${unknown.join(', ')}`,
    );
  const judged = screens ?? [...captured.keys()];
  const verdict = {
    judged: judged.length,
    findingCount: 0,
    failures: [],
    resolved: [],
  };
  for (const name of judged) {
    const screen = judgeScreen(
      name,
      captured.get(name),
      allowlist.screens[name] ?? [],
    );
    verdict.findingCount += screen.count;
    verdict.failures.push(...screen.failures);
    verdict.resolved.push(...screen.resolved);
  }
  // A full capture also retires entries for screens that no longer exist.
  if (!screens && capture.selection === null)
    for (const [name, identities] of Object.entries(allowlist.screens))
      if (!captured.has(name))
        verdict.resolved.push(
          ...identities.map((identity) => ({ screen: name, identity })),
        );
  return verdict;
}

export function formatVerdict(verdict, { partial }) {
  const lines = [];
  for (const failure of verdict.failures)
    lines.push(
      `FAIL ${failure.screen}: ${failure.identity}${failure.detail ? ` — ${failure.detail}` : ''}`,
    );
  for (const { screen, identity } of verdict.resolved)
    lines.push(
      `RESOLVED ${screen}: ${identity} (remove it: node scripts/gallery-ui-findings.mjs prune)`,
    );
  lines.push(
    `${verdict.failures.length === 0 ? 'OK' : 'FAILED'}: ${verdict.judged} screen(s)${partial ? ' (partial capture)' : ''}, ` +
      `${verdict.findingCount} finding(s), ${verdict.failures.length} not allowlisted, ${verdict.resolved.length} allowlisted finding(s) resolved`,
  );
  return lines;
}

function sortedScreens(screens) {
  return Object.fromEntries(
    Object.entries(screens)
      .filter(([, ids]) => ids.length > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, ids]) => [name, [...new Set(ids)].sort()]),
  );
}

/**
 * The repository formatter's layout (Biome, 80 columns): an array stays on
 * one line when that line fits, so a written allowlist needs no reformat.
 */
function formatAllowlist(screens) {
  const entries = Object.entries(sortedScreens(screens));
  if (entries.length === 0)
    return '{\n  "schemaVersion": 1,\n  "screens": {}\n}\n';
  const lines = ['{', '  "schemaVersion": 1,', '  "screens": {'];
  entries.forEach(([name, ids], index) => {
    const comma = index < entries.length - 1 ? ',' : '';
    const key = `    ${JSON.stringify(name)}: [`;
    const inline = `${key}${ids.map((id) => JSON.stringify(id)).join(', ')}]${comma}`;
    if (inline.length <= 80) lines.push(inline);
    else
      lines.push(
        key,
        ...ids.map(
          (id, i) =>
            `      ${JSON.stringify(id)}${i < ids.length - 1 ? ',' : ''}`,
        ),
        `    ]${comma}`,
      );
  });
  lines.push('  }', '}');
  return `${lines.join('\n')}\n`;
}

function writeAllowlist(path, screens) {
  writeFileSync(path, formatAllowlist(screens));
}

function requireFullCleanCapture(capture) {
  if (capture.selection !== null)
    throw new UsageError(
      'this mode needs a full capture, not a --screens subset',
    );
  const bad = capture.screens.filter(
    (entry) => !entry.ok || !entry.uiAudit || entry.uiAudit.error,
  );
  if (bad.length > 0)
    throw new UsageError(
      `this mode needs every screen captured and audited; not usable: ${bad.map((entry) => entry.name).join(', ')}`,
    );
}

/**
 * Pairs in `head` that `base` does not list, split by whether their screen is
 * new: absent from the base allowlist and from `baseScreens`.
 */
export function allowlistGrowth(base, head, baseScreens) {
  const added = [];
  const newScreens = [];
  for (const [screen, identities] of Object.entries(head.screens)) {
    if (!Object.hasOwn(base.screens, screen) && !baseScreens.has(screen)) {
      newScreens.push({ screen, count: identities.length });
      continue;
    }
    const before = new Set(base.screens[screen] ?? []);
    for (const identity of identities)
      if (!before.has(identity)) added.push({ screen, identity });
  }
  return { added, newScreens };
}

/** A file at `base`, or null when the path does not exist there. */
function showAtBase(base, path) {
  try {
    return execFileSync('git', ['show', `${base}:${path}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    const stderr = String(error.stderr ?? '');
    // The path not existing at a resolvable base is the bootstrap case; any
    // other git failure (unknown ref) is an input error, not a pass.
    if (/does not exist in|exists on disk, but not in/.test(stderr))
      return null;
    throw new UsageError(
      `cannot read ${path} at ${base}: ${stderr.trim() || error.message}`,
    );
  }
}

function readBaseAllowlist(base, path) {
  const text = showAtBase(base, path);
  return text === null ? null : parseAllowlist(text, `${base}:${path}`);
}

/** The base revision's gallery screen names (its own copy of the map). */
async function readBaseScreens(base) {
  const text = showAtBase(base, SCREEN_SOURCES);
  if (text === null) return new Set();
  const dir = mkdtempSync(join(tmpdir(), 'gallery-base-screens-'));
  try {
    const file = join(dir, 'gallery-screen-sources.mjs');
    writeFileSync(file, text);
    const { GALLERY_SCREEN_ENTRIES } = await import(pathToFileURL(file).href);
    if (!GALLERY_SCREEN_ENTRIES || typeof GALLERY_SCREEN_ENTRIES !== 'object')
      throw new UsageError(`${base}:${SCREEN_SOURCES} names no screens`);
    return new Set(Object.keys(GALLERY_SCREEN_ENTRIES));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runGrowth(options) {
  const head = readAllowlist(options.allowlist);
  const base = readBaseAllowlist(options.base, options.allowlist);
  if (!base) {
    console.log(
      `${options.allowlist} does not exist at ${options.base}; this revision establishes the ceiling.`,
    );
    return 0;
  }
  const { added, newScreens } = allowlistGrowth(
    base,
    head,
    await readBaseScreens(options.base),
  );
  for (const { screen, count } of newScreens)
    console.log(
      `NEW SCREEN ${screen}: ${count} finding(s) listed with new coverage`,
    );
  for (const { screen, identity } of added)
    console.log(`GROWTH ${screen}: ${identity}`);
  console.log(
    added.length === 0
      ? `OK: ${options.allowlist} only shrinks for screens ${options.base} already had.`
      : `FAILED: ${added.length} allowlist entr${added.length === 1 ? 'y' : 'ies'} added for screens ${options.base} already had. Fix the finding instead of listing it; only a new screen may arrive with its findings listed.`,
  );
  return added.length === 0 ? 0 : 1;
}

function runSeed(options) {
  const capture = readCapture(options.gallery);
  if (existsSync(options.allowlist))
    throw new UsageError(
      `${options.allowlist} exists; seed writes only the first allowlist`,
    );
  requireFullCleanCapture(capture);
  writeAllowlist(
    options.allowlist,
    Object.fromEntries(
      capture.screens.map((entry) => [
        entry.name,
        entry.uiAudit.findings.map((finding) => finding.identity),
      ]),
    ),
  );
  console.log(
    `Seeded ${options.allowlist} from ${capture.screens.length} screens.`,
  );
  return 0;
}

function runPrune(options) {
  const capture = readCapture(options.gallery);
  const allowlist = readAllowlist(options.allowlist);
  requireFullCleanCapture(capture);
  const drop = new Set(
    judge(capture, allowlist, undefined).resolved.map(
      ({ screen, identity }) => `${screen}\n${identity}`,
    ),
  );
  writeAllowlist(
    options.allowlist,
    Object.fromEntries(
      Object.entries(allowlist.screens).map(([screen, ids]) => [
        screen,
        ids.filter((identity) => !drop.has(`${screen}\n${identity}`)),
      ]),
    ),
  );
  console.log(
    `Pruned ${drop.size} resolved entr${drop.size === 1 ? 'y' : 'ies'} from ${options.allowlist}.`,
  );
  return 0;
}

function runCheck(options) {
  const capture = readCapture(options.gallery);
  const verdict = judge(
    capture,
    readAllowlist(options.allowlist),
    options.screens,
  );
  const lines = formatVerdict(verdict, {
    partial: Boolean(options.screens) || capture.selection !== null,
  });
  console.log(lines.join('\n'));
  if (options.summary)
    appendFileSync(
      options.summary,
      `\n### Gallery product assertions\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`,
    );
  return verdict.failures.length === 0 ? 0 : 1;
}

function runAdopt(options) {
  const capture = readCapture(options.gallery);
  const allowlist = readAllowlist(options.allowlist);
  const captured = new Map(capture.screens.map((entry) => [entry.name, entry]));
  const adopted = {};
  for (const name of options.screens) {
    if (Object.hasOwn(allowlist.screens, name))
      throw new UsageError(
        `${name} is already in ${options.allowlist}; adopt only lists a screen the allowlist does not name`,
      );
    const entry = captured.get(name);
    const unusable = entry ? unusableScreen(entry) : null;
    if (!entry || unusable)
      throw new UsageError(
        `${name} was not captured and audited in this gallery${unusable ? ` (${unusable.identity})` : ''}`,
      );
    adopted[name] = entry.uiAudit.findings.map(({ identity }) => identity);
  }
  writeAllowlist(options.allowlist, { ...allowlist.screens, ...adopted });
  for (const [name, identities] of Object.entries(adopted))
    console.log(`Adopted ${name}: ${identities.length} finding(s).`);
  console.log(
    'The allowlist-ceiling check accepts these only for screens new to the base revision.',
  );
  return 0;
}

const RUNNERS = {
  check: runCheck,
  prune: runPrune,
  growth: runGrowth,
  seed: runSeed,
  adopt: runAdopt,
};

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    return await RUNNERS[options.mode](options);
  } catch (error) {
    console.error(
      `gallery-ui-findings: ${error instanceof Error ? error.message : error}`,
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
if (isMain)
  main().then((code) => {
    process.exitCode = code;
  });
