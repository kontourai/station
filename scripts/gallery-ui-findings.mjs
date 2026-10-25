#!/usr/bin/env node
// Judges the gallery's product assertions (hit targets, horizontal overflow,
// blocking axe) that tests/screenshots.spec.ts records per screen in
// `gallery/capture.json` under `uiAudit`, against the shrink-only allowlist.
//
//   node scripts/gallery-ui-findings.mjs check  [--gallery=<dir>] [--allowlist=<file>] [--screens=a,b] [--summary=<file>]
//   node scripts/gallery-ui-findings.mjs prune  [--gallery=<dir>] [--allowlist=<file>]
//   node scripts/gallery-ui-findings.mjs growth --base=<git-ref> [--allowlist=<file>]
//   node scripts/gallery-ui-findings.mjs seed   [--gallery=<dir>] [--allowlist=<file>]
//
// `check` fails (exit 1) on any finding the allowlist does not name for that
// screen, and on a captured screen whose audit is missing or threw. A
// listed finding that no longer occurs never fails; it is reported so
// `prune` can remove it. The allowlist is keyed by screen name plus finding
// identity (no line numbers, counts, or measurements), so it changes only
// when a finding appears or goes away. `growth` fails when the allowlist
// names any (screen, identity) pair its base revision did not: the list only
// shrinks. `seed` writes the first allowlist and refuses once one exists.
// Exit 2 is a usage or input error, never a verdict.
//
// Self-contained (node built-ins only): the PR workflow runs the BASE
// revision's copy from a temp directory for `growth`, so a candidate cannot
// rewrite the rule that judges its own allowlist.
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ALLOWLIST = 'tests/gallery-ui-findings.allowlist.json';
const MODES = new Set(['check', 'prune', 'growth', 'seed']);

class UsageError extends Error {}

export function parseArgs(argv) {
  // `check` is the default so `node scripts/gallery-ui-findings.mjs --screens=a`
  // reads naturally.
  const [mode, ...rest] =
    argv.length === 0 || argv[0].startsWith('--') ? ['check', ...argv] : argv;
  if (!MODES.has(mode))
    throw new UsageError(
      `first argument must be one of ${[...MODES].join(', ')} (got ${mode ?? 'nothing'})`,
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

/**
 * The verdict, as data. `failures` are unlisted findings and unusable audits;
 * `resolved` are listed findings this capture no longer produces.
 */
export function judge(capture, allowlist, screens) {
  const captured = new Map(capture.screens.map((entry) => [entry.name, entry]));
  if (screens) {
    const unknown = screens.filter((name) => !captured.has(name));
    if (unknown.length > 0)
      throw new UsageError(
        `--screens names screens this capture does not have: ${unknown.join(', ')}`,
      );
  }
  const judged = screens ?? [...captured.keys()];
  const failures = [];
  const resolved = [];
  let findingCount = 0;
  for (const name of judged) {
    const entry = captured.get(name);
    const listed = new Set(allowlist.screens[name] ?? []);
    if (!entry.ok) {
      failures.push({
        screen: name,
        identity: 'capture-failed',
        detail: entry.error ?? 'screen did not render',
      });
      continue;
    }
    const audit = entry.uiAudit;
    if (!audit || (!Array.isArray(audit.findings) && !audit.error)) {
      failures.push({
        screen: name,
        identity: 'audit-missing',
        detail: 'capture.json carries no uiAudit for this screen',
      });
      continue;
    }
    if (audit.error) {
      failures.push({
        screen: name,
        identity: 'audit-error',
        detail: audit.error,
      });
      continue;
    }
    const seen = new Set();
    for (const finding of audit.findings) {
      findingCount += 1;
      seen.add(finding.identity);
      if (!listed.has(finding.identity))
        failures.push({ screen: name, ...finding });
    }
    for (const identity of listed)
      if (!seen.has(identity)) resolved.push({ screen: name, identity });
  }
  // A full capture also retires entries for screens that no longer exist.
  if (!screens && capture.selection === null)
    for (const [name, identities] of Object.entries(allowlist.screens))
      if (!captured.has(name))
        for (const identity of identities)
          resolved.push({ screen: name, identity });
  return { judged: judged.length, findingCount, failures, resolved };
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

function writeAllowlist(path, screens) {
  writeFileSync(
    path,
    `${JSON.stringify({ schemaVersion: 1, screens: sortedScreens(screens) }, null, 2)}\n`,
  );
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

/** Pairs in `head` that `base` does not list. */
export function allowlistGrowth(base, head) {
  const added = [];
  for (const [screen, identities] of Object.entries(head.screens)) {
    const before = new Set(base.screens[screen] ?? []);
    for (const identity of identities)
      if (!before.has(identity)) added.push({ screen, identity });
  }
  return added;
}

function readBaseAllowlist(base, path) {
  try {
    return parseAllowlist(
      execFileSync('git', ['show', `${base}:${path}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }),
      `${base}:${path}`,
    );
  } catch (error) {
    if (error instanceof UsageError) throw error;
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

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.mode === 'growth') {
      const head = readAllowlist(options.allowlist);
      const base = readBaseAllowlist(options.base, options.allowlist);
      if (!base) {
        console.log(
          `${options.allowlist} does not exist at ${options.base}; this revision establishes the ceiling.`,
        );
        return 0;
      }
      const added = allowlistGrowth(base, head);
      for (const { screen, identity } of added)
        console.log(`GROWTH ${screen}: ${identity}`);
      console.log(
        added.length === 0
          ? `OK: ${options.allowlist} only shrinks relative to ${options.base}.`
          : `FAILED: ${added.length} allowlist entr${added.length === 1 ? 'y' : 'ies'} added relative to ${options.base}. Fix the finding instead of listing it.`,
      );
      return added.length === 0 ? 0 : 1;
    }
    const capture = readCapture(options.gallery);
    if (options.mode === 'seed') {
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
    const allowlist = readAllowlist(options.allowlist);
    if (options.mode === 'prune') {
      requireFullCleanCapture(capture);
      const { resolved } = judge(capture, allowlist, undefined);
      const drop = new Set(
        resolved.map(({ screen, identity }) => `${screen}\n${identity}`),
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
    const verdict = judge(capture, allowlist, options.screens);
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
if (isMain) process.exitCode = main();
