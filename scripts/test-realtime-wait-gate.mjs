#!/usr/bin/env node
/**
 * Real-time waits in NEW test code.
 *
 * A test that waits a fixed amount of real time and then asserts ("the
 * install has started by now", "the hold has lapsed by now", "eight 10ms
 * retries are enough") passes on an idle machine and fails some of the time
 * on a saturated runner. The merge queue runs each test once, so such a test
 * usually gets through and reds Nightly later. Four did on 2026-09-23:
 *   - `await new Promise((resolve) => setTimeout(resolve, 50))` (plugin lock)
 *   - `setTimeout(resolve, HOLD_MS * 3)` against a 40ms hold (browser lease)
 *   - `await sleep(90)` against a 120ms ceiling (live-surface registry)
 *   - `Atomics.wait(..., 10)` in an 8-attempt retry loop (profile store)
 * Repeating tests under CPU pressure did not reproduce them; each one was
 * visible in the line that added it. So this reads the lines a change ADDS to
 * test files and flags those shapes.
 *
 * It is a prompt, not a proof, and it REPORTS rather than blocks. In a
 * one-off replay over the 150 main commits before 2026-09-24 (not kept as an
 * artifact), roughly 40% of what it flagged was the hazard (a sleep,
 * then an assertion that something DID happen); the rest sleep before a
 * negative assertion, which load can only make pass, or sleep inside a loop
 * that already polls. Blocking at that precision would teach waiver-pasting,
 * so in CI each finding is an inline `::warning` on the added line plus a step
 * summary, and the exit is 0. `--strict` exits 1 on findings. A line that
 * genuinely needs real time says so with a `real-time: <reason>` comment on
 * that line or the line above, which silences it. Existing lines are never
 * flagged; the line above an added one is read from HEAD only for a waiver.
 *
 *   node scripts/test-realtime-wait-gate.mjs [--base=<ref>] [--strict]
 *
 * The base defaults to STATION_CI_FAST_BASE, then origin/main, and the
 * comparison is `<base>...HEAD`.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';

const TEST_PATH = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const CODE_PATH = /\.[cm]?[jt]sx?$/;
const WAIVER = /real-time:\s*\S/;

const REALTIME_WAIT_PATTERNS = Object.freeze([
  Object.freeze({
    id: 'promise-sleep',
    // A promise that settles after a fixed real delay, typically awaited
    // before an assertion: setTimeout(resolve, N), setTimeout(() => resolve(),
    // N), setTimeout(() => { resolve(); }, N), and a timer resolving with any
    // value that is not a sentinel. A literal 0 is a task yield, not a wait.
    //
    // Not flagged: a timer resolving with a string literal or an UPPER_CASE
    // constant, the `Promise.race([op, timeout('TIMED_OUT')])` shape. That is
    // a sentinel, and it is only safe when the test EXPECTS the sentinel (a
    // negative assertion); `.not.toBe('TIMED_OUT')` asserts `op` finished in
    // time and load can fail it. The exemption is syntactic, so it trusts the
    // sentinel form to mean the former -- a reviewer's check, not the gate's.
    pattern:
      /\bsetTimeout\(\s*(?:resolve|res|r|done|next)\s*,(?!\s*0\s*\))|\bsetTimeout\(\s*\(\)\s*=>\s*\{?\s*(?:resolve|res|r|done|next)\s*\((?!\s*(?:'[^']*'|"[^"]*"|`[^`]*`|[A-Z][A-Z0-9_]*)\s*\))[^;\n]{0,200}?\)\s*;?\s*\}?\s*,(?!\s*0\s*\))/,
  }),
  Object.freeze({
    id: 'literal-sleep',
    // sleep(90), delay(1_000), wait(50): a helper call with a literal
    // duration, and sleep(ms) / delay(delayMs) with any single argument
    // (`wait` and `pause` stay literal-only; they are common non-time names).
    pattern:
      /(?<![\w.])(?:sleep|delay|wait|pause)\(\s*(?!0\s*\))\d[\d_]*\s*\)|(?<![\w.])(?:sleep|delay)\(\s*[A-Za-z_$][\w$.]*\s*\)/,
  }),
  Object.freeze({
    id: 'blocking-wait',
    // Atomics.wait(buffer, 0, 0, 10): a synchronous real-time nap.
    // Nested calls are common in the buffer argument, so match to the last
    // numeric argument on the line rather than to the first `)`.
    pattern: /\bAtomics\.wait\(.*,\s*\d[\d_]*\s*\)/,
  }),
]);

/** Undo git's C-style quoting of a path (`"b/\\303\\251 x.ts"`). */
export function unquoteGitPath(path) {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes = [];
  const body = path.slice(1, -1);
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[i + 1];
    if (/[0-7]/.test(next ?? '')) {
      bytes.push(Number.parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
      continue;
    }
    const escapes = {
      n: 10,
      t: 9,
      r: 13,
      '"': 34,
      '\\': 92,
      a: 7,
      b: 8,
      f: 12,
      v: 11,
    };
    bytes.push(escapes[next] ?? next.charCodeAt(0));
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Added lines of test files from a `git diff --unified=0` of the change, as
 * `{ file, line, text }` with the line number in the new file. Lines inside a
 * hunk are consumed by the hunk's own counts, so added content that happens
 * to start with `++ ` is content, never a new file header.
 */
export function addedTestLines(diff) {
  const added = [];
  let file = null;
  let line = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (raw.startsWith('\\')) continue;
      if (raw.startsWith('+')) {
        if (file) added.push({ file, line, text: raw.slice(1) });
        line += 1;
        newLeft -= 1;
      } else if (raw.startsWith('-')) {
        oldLeft -= 1;
      } else {
        line += 1;
        oldLeft -= 1;
        newLeft -= 1;
      }
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const path = unquoteGitPath(raw.slice(4).replace(/\t$/, '').trim());
      const relative = path.startsWith('b/') ? path.slice(2) : null;
      file =
        relative && TEST_PATH.test(relative) && CODE_PATH.test(relative)
          ? relative
          : null;
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      line = Number(hunk[2]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
    }
  }
  return added;
}

/**
 * The added lines that wait on real time without a waiver. `lineOf(file, n)`
 * returns line n (1-based) of the new file, to read a waiver on the line
 * above an added line whether or not that line was itself added.
 */
export function findRealtimeWaits(added, lineOf) {
  const findings = [];
  for (const entry of added) {
    const match = REALTIME_WAIT_PATTERNS.find(({ pattern }) =>
      pattern.test(entry.text),
    );
    if (!match) continue;
    const above =
      entry.line > 1 ? (lineOf(entry.file, entry.line - 1) ?? '') : '';
    if (WAIVER.test(entry.text) || WAIVER.test(above)) continue;
    findings.push({ ...entry, kind: match.id });
  }
  return findings;
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function runRealtimeWaitGate(root, base) {
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  // Explicit prefixes, unquoted paths and no textconv: a user's diff.noprefix,
  // a non-ASCII filename or a textconv driver must not hide added lines.
  const diff = git(root, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--unified=0',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--diff-filter=ACMR',
    `${base}...HEAD`,
  ]);
  const added = addedTestLines(diff);
  const cache = new Map();
  // The waiver above is read from HEAD -- the commit being judged -- not from
  // a working tree that may carry uncommitted edits.
  const lineOf = (file, number) => {
    if (!cache.has(file)) {
      try {
        cache.set(file, git(root, ['show', `HEAD:${file}`]).split('\n'));
      } catch {
        cache.set(file, []);
      }
    }
    return cache.get(file)[number - 1];
  };
  return {
    base,
    head,
    scannedLines: added.length,
    findings: findRealtimeWaits(added, lineOf),
  };
}

/** GitHub's workflow-command escaping for a message. */
function escapeData(value) {
  return String(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

/** ...and for a property, where `:` and `,` also delimit. */
function escapeProperty(value) {
  return escapeData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

/**
 * One GitHub Actions annotation per finding, on the added line itself. A
 * filename is author-controlled, so it is escaped: unescaped, a `,` in it
 * moves the warning and a newline starts a new workflow command.
 */
export function realtimeWaitAnnotations(findings) {
  return findings.map(
    (f) =>
      `::warning file=${escapeProperty(f.file)},line=${f.line},title=${escapeProperty(`Real-time wait in a test (${f.kind})`)}::A fixed real-time wait passes on an idle machine and can fail on a saturated CI runner. Wait for the event, drive time with an injected or fake clock, or add a real-time: <reason> comment. See "Real-time waits in tests" in docs/guides/testing.md.`,
  );
}

function formatRealtimeWaitReport(result) {
  if (result.scannedLines === 0) {
    return `[test-realtime-wait] no test lines added between ${result.base} and ${result.head}; nothing to check.`;
  }
  if (result.findings.length === 0) {
    return `[test-realtime-wait] OK: ${result.scannedLines} added test line(s), no unexplained real-time wait.`;
  }
  return [
    `[test-realtime-wait] ${result.findings.length} added test line(s) wait on real time:`,
    ...result.findings.map(
      (f) => `  ${f.file}:${f.line} [${f.kind}] ${f.text.trim()}`,
    ),
    '',
    'A fixed real-time wait passes on an idle machine and fails on a saturated CI runner, so the',
    'test lands green and reds Nightly later. Instead:',
    '  - wait for the event itself (resolve a promise from the code under test, expect.poll, vi.waitFor);',
    '  - drive time: an injected clock (`now`), or vi.useFakeTimers() + vi.advanceTimersByTimeAsync();',
    '  - bound a retry by a wall-clock deadline, not by an attempt count.',
    'If the line genuinely needs real time (a negative assertion, a test of a timeout itself), say',
    'why with a `real-time: <reason>` comment on that line or the line above.',
    'See "Real-time waits in tests" in docs/guides/testing.md.',
  ].join('\n');
}

if (invokedDirectly(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const strict = args.includes('--strict');
    const rest = args.filter((arg) => arg !== '--strict');
    if (rest.length > 1 || (rest.length && !rest[0].startsWith('--base=')))
      throw new Error(
        'Usage: node scripts/test-realtime-wait-gate.mjs [--base=<ref>] [--strict]',
      );
    const base =
      rest[0]?.slice('--base='.length) ||
      process.env.STATION_CI_FAST_BASE ||
      'origin/main';
    if (!base || base.startsWith('-'))
      throw new Error('Invalid real-time wait gate base');
    const result = runRealtimeWaitGate(process.cwd(), base);
    console.log(formatRealtimeWaitReport(result));
    if (process.env.GITHUB_ACTIONS === 'true') {
      for (const annotation of realtimeWaitAnnotations(result.findings))
        console.log(annotation);
    }
    if (process.env.GITHUB_STEP_SUMMARY && result.findings.length > 0)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\n### Real-time waits added to tests\n\n${result.findings.length} added test line(s) wait on real time (report-only; see the inline warnings):\n\n${result.findings.map((f) => `- \`${f.file.replace(/[`\r\n]/g, '?')}:${f.line}\` (${f.kind})`).join('\n')}\n`,
      );
    if (strict && result.findings.length > 0) process.exit(1);
  } catch (error) {
    console.error(
      `[test-realtime-wait] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
}
