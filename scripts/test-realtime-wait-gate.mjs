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
 * It is a prompt, not a proof. It sees three textual shapes, not every way to
 * wait, and a line that genuinely needs real time -- a negative assertion
 * ("nothing happens within 50ms"), a test of a timeout itself -- is fine once
 * it says so: a `real-time: <reason>` comment on that line or the line above
 * waives it. Existing lines are never flagged.
 *
 *   node scripts/test-realtime-wait-gate.mjs [--base=<ref>]
 *
 * The base defaults to STATION_CI_FAST_BASE, then origin/main, and the
 * comparison is `<base>...HEAD`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_PATH = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const CODE_PATH = /\.[cm]?[jt]sx?$/;
const WAIVER = /real-time:\s*\S/;

export const REALTIME_WAIT_PATTERNS = Object.freeze([
  Object.freeze({
    id: 'promise-sleep',
    // setTimeout(resolve, N) and setTimeout(() => resolve(), N): a promise
    // that settles after a fixed real delay, typically awaited before an
    // assertion. A literal 0 is a task yield, not a wait. A timer that
    // resolves WITH a value (`() => resolve('timed-out')`) is a Promise.race
    // guard: it mostly proves something did NOT happen, which load can only
    // make pass, so it is not flagged either.
    pattern:
      /\bsetTimeout\(\s*(?:resolve|res|r|done|next)\s*,(?!\s*0\s*\))|\bsetTimeout\(\s*\(\)\s*=>\s*(?:resolve|res|r|done|next)\s*\(\s*\)\s*,(?!\s*0\s*\))/,
  }),
  Object.freeze({
    id: 'literal-sleep',
    // sleep(90), delay(1_000), wait(50): a helper call with a literal duration.
    pattern: /(?<![\w.])(?:sleep|delay|wait|pause)\(\s*(?!0\s*\))\d[\d_]*\s*\)/,
  }),
  Object.freeze({
    id: 'blocking-wait',
    // Atomics.wait(buffer, 0, 0, 10): a synchronous real-time nap.
    // Nested calls are common in the buffer argument, so match to the last
    // numeric argument on the line rather than to the first `)`.
    pattern: /\bAtomics\.wait\(.*,\s*\d[\d_]*\s*\)/,
  }),
]);

/**
 * Added lines of test files from a `git diff --unified=0` of the change, as
 * `{ file, line, text }` with the line number in the new file.
 */
export function addedTestLines(diff) {
  const added = [];
  let file = null;
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4).trim();
      file =
        path.startsWith('b/') &&
        TEST_PATH.test(path.slice(2)) &&
        CODE_PATH.test(path.slice(2))
          ? path.slice(2)
          : null;
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('+')) {
      added.push({ file, line, text: raw.slice(1) });
      line += 1;
    } else if (!raw.startsWith('-') && !raw.startsWith('\\')) {
      line += 1;
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

export function runRealtimeWaitGate(root, base) {
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const diff = git(root, [
    'diff',
    '--unified=0',
    '--no-color',
    '--no-ext-diff',
    '--diff-filter=ACMR',
    `${base}...HEAD`,
  ]);
  const added = addedTestLines(diff);
  const cache = new Map();
  const lineOf = (file, number) => {
    if (!cache.has(file)) {
      try {
        cache.set(file, readFileSync(join(root, file), 'utf8').split('\n'));
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

export function formatRealtimeWaitReport(result) {
  if (result.scannedLines === 0) {
    return `[test-realtime-wait] no test lines added between ${result.base} and ${result.head}; nothing to check.`;
  }
  if (result.findings.length === 0) {
    return `[test-realtime-wait] OK: ${result.scannedLines} added test line(s), no unexplained real-time wait.`;
  }
  return [
    `[test-realtime-wait] FAIL: ${result.findings.length} added test line(s) wait on real time:`,
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

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length && !args[0].startsWith('--base=')))
      throw new Error(
        'Usage: node scripts/test-realtime-wait-gate.mjs [--base=<ref>]',
      );
    const base =
      args[0]?.slice('--base='.length) ||
      process.env.STATION_CI_FAST_BASE ||
      'origin/main';
    if (!base || base.startsWith('-'))
      throw new Error('Invalid real-time wait gate base');
    const result = runRealtimeWaitGate(process.cwd(), base);
    console.log(formatRealtimeWaitReport(result));
    if (result.findings.length > 0) process.exit(1);
  } catch (error) {
    console.error(
      `[test-realtime-wait] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
}
