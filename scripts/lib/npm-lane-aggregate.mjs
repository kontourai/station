/**
 * Run a fixed catalog of independent `npm run <script>` lanes TO COMPLETION
 * and report every failing one, instead of the `&&`-chained fail-fast
 * behavior this replaces (station#4249).
 *
 * `npm run typecheck` and `npm run docs:truth:gate` used to chain 12
 * independent checks each with `&&`. The chain dies at the FIRST failure, so
 * a candidate branch inheriting N independent breaks from a moving `main`
 * cost N full receipt cycles to discover what one run could have reported --
 * every one of those checks is its own TypeScript project or its own
 * standalone repo-hygiene script; nothing about `typecheck:ui` depends on
 * `typecheck:server-tests` passing, and nothing about `docs:links:check`
 * depends on `docs:index:check` passing.
 *
 * This module is the shared orchestration both `typecheck-aggregate.mjs` and
 * `docs-truth-gate-aggregate.mjs` are built from: run every lane regardless
 * of what came before, print a combined summary naming every failing lane,
 * and still exit non-zero if any lane failed. Each lane's own command is
 * untouched -- this module only changes HOW MANY of them run, never what any
 * one of them does. `--silent` suppresses npm's own `> pkg@ver script`
 * banner (verified: it does not suppress the child's own stdout/stderr), so
 * a failing lane's output is not misread by the receipt reporter's chained-
 * `&&` step-boundary scoping (`scripts/lib/verification-reporter.mjs`),
 * which assumes a single fail-fast chain and would otherwise treat a nested
 * banner as though this were still one.
 */
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';

export const DEFAULT_CONCURRENCY = 4;

/**
 * How many lanes to run at once. Bounded by the requested concurrency, the
 * host's CPU count (each lane is a CPU-bound `tsc`/node process), and the
 * lane count itself -- never spawn more workers than there is work.
 */
export function planConcurrency(laneCount, { concurrency, cpuCount } = {}) {
  const cpuBound =
    Number.isInteger(cpuCount) && cpuCount > 0
      ? cpuCount
      : (cpus()?.length ?? 1);
  const requested =
    Number.isInteger(concurrency) && concurrency > 0
      ? concurrency
      : DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(requested, cpuBound, Math.max(1, laneCount)));
}

/**
 * Bounded-concurrency map: runs `worker` over `items`, at most `limit` in
 * flight at once, preserving input order in the returned results array.
 *
 * @template T
 * @template R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runNext() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, runNext));
  return results;
}

/**
 * Runs one lane via `npm run --silent <script>` and captures its outcome.
 * Pure glue over child_process: every decision about what counts as failure
 * or how to summarize belongs elsewhere so it can be tested without spawning
 * anything.
 *
 * @param {{ id: string, script: string }} lane
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   spawnFn?: (command: string, args: string[], options: object) => import('node:child_process').ChildProcess,
 *   npmBin?: string,
 *   platform?: string,
 * }} [options]
 *   `npmBin` has no default value. `tsconfig.scripts.json` runs with
 *   checkJs:false, where tsc otherwise infers an exported function's
 *   parameter type from its INITIALIZED properties only -- the same footgun
 *   `persistVerificationOutput`'s own `@param` comment documents in
 *   `verification-reporter.mjs` -- so without this annotation a `.ts`
 *   importer's options object would silently drop `npmBin` from the
 *   inferred shape entirely.
 */
export function runLane(
  lane,
  {
    cwd = process.cwd(),
    env = process.env,
    spawnFn = spawn,
    npmBin,
    platform = process.platform,
  } = {},
) {
  const isWindows = platform === 'win32';
  const bin = npmBin ?? (isWindows ? 'npm.cmd' : 'npm');
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawnFn(bin, ['run', '--silent', lane.script], {
        cwd,
        env,
        windowsHide: true,
        // station#4249 review: `shell: false` throws a SYNCHRONOUS `spawn
        // EINVAL` for a `.cmd`/`.bat` target on Windows since Node's
        // CVE-2024-27980 hardening (reproduced live on Node 24.5,
        // self-hosted Windows runner) -- every lane failed regardless of
        // whether the code compiled, on the exact host
        // `.github/workflows/windows-verification.yml` runs `npm run
        // typecheck` on as a required step. `shell: true` on win32 is safe
        // here specifically because `lane.script` is never caller-supplied
        // free text: every value reaching this function comes from the
        // hardcoded `TYPECHECK_LANES`/`DOCS_TRUTH_GATE_LANES` constants in
        // this repo's own source, so there is no shell-injection surface to
        // guard against. POSIX keeps `shell: false` -- npm resolves as a
        // normal executable there and needs no shell mediation.
        // Forward-compat note (observed live on Windows/Node 24): `shell:true`
        // with an args ARRAY emits DEP0190, because Node does not escape array
        // args for the shell. Harmless here for the reason above -- every arg
        // is a repo constant -- but if a future Node promotes DEP0190 to a
        // hard error, move this to an explicit `cmd.exe /d /s /c` invocation
        // rather than reaching for string concatenation. The warning also
        // lands on stderr for every Windows lane; it matches no
        // `isCausalDiagnostic` pattern, so it cannot pollute causalExcerpts.
        shell: isWindows,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        ...lane,
        ok: false,
        exitCode: null,
        seconds: 0,
        stdout: '',
        stderr: String(error?.message ?? error),
        spawnError: true,
      });
      return;
    }
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      resolve({
        ...lane,
        ok: false,
        exitCode: null,
        seconds: (Date.now() - started) / 1000,
        stdout,
        stderr: stderr
          ? `${stderr}\n${String(error?.message ?? error)}`
          : String(error?.message ?? error),
        spawnError: true,
      });
    });
    child.once('close', (code) => {
      resolve({
        ...lane,
        ok: code === 0,
        exitCode: code,
        seconds: (Date.now() - started) / 1000,
        stdout,
        stderr,
        spawnError: false,
      });
    });
  });
}

/**
 * The first diagnostic-shaped line in one lane's own captured output, used
 * only to make the per-lane `FAIL <lane>: ...` summary line more actionable.
 * The FULL captured output is always printed alongside it (see
 * `summarizeLaneResults`), so this is a convenience index, not the record of
 * truth -- a lane whose output has no line matching any of these shapes still
 * fails and still gets a bare `FAIL <lane>` line.
 */
export function firstLaneDiagnostic(entry) {
  const lines = `${entry.stdout ?? ''}\n${entry.stderr ?? ''}`.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (
      /error TS\d+:/.test(line) ||
      /^(?:FAIL:|Error:)/i.test(line) ||
      /\b(?:AssertionError|TypeError|ReferenceError|SyntaxError|RangeError)\b/.test(
        line,
      ) ||
      /━━━/.test(line) ||
      /^FAIL\s+\S+/.test(line)
    )
      return line;
  }
  return null;
}

/**
 * Pure: given already-completed lane results, produce the printable report
 * text and the pass/fail verdict. Never spawns anything, so this is the part
 * unit tests exercise directly without a real child process.
 *
 * Every lane's full captured stdout/stderr is printed under its own `---
 * <lane> ---` marker (never an npm `> pkg@ver script` banner shape -- see the
 * module doc comment on why that matters to the receipt reporter), followed
 * by one `FAIL <lane>[: <diagnostic>]` line per failing lane. Those FAIL
 * lines are what `scripts/lib/verification-reporter.mjs`'s `causalExcerpts`
 * collects one excerpt per, so the receipt names every failing lane, not only
 * the first.
 */
export function summarizeLaneResults(results, { label } = {}) {
  const failed = results.filter((entry) => !entry.ok);
  const lines = [];
  for (const entry of results) {
    const seconds =
      typeof entry.seconds === 'number' ? entry.seconds.toFixed(1) : '?';
    lines.push(
      `--- ${entry.id} (${seconds}s) ${entry.ok ? 'OK' : `FAILED (exit ${entry.exitCode ?? 'null'})`} ---`,
    );
    const stdout = (entry.stdout ?? '').replace(/\n+$/, '');
    const stderr = (entry.stderr ?? '').replace(/\n+$/, '');
    if (stdout) lines.push(stdout);
    if (stderr) lines.push(stderr);
  }
  for (const entry of failed) {
    const diagnostic = firstLaneDiagnostic(entry);
    lines.push(`FAIL ${entry.id}${diagnostic ? `: ${diagnostic}` : ''}`);
  }
  lines.push(
    failed.length
      ? `FAIL: ${label} -- ${failed.length} of ${results.length} lane(s) failed: ${failed
          .map((entry) => entry.id)
          .join(', ')}`
      : `OK: ${label} -- all ${results.length} lane(s) passed.`,
  );
  return {
    ok: failed.length === 0,
    text: lines.join('\n'),
    failedLaneIds: failed.map((entry) => entry.id),
    passedCount: results.length - failed.length,
    totalCount: results.length,
  };
}

/**
 * Runs every lane in `lanes` to completion (bounded concurrency, never
 * fail-fast between them) and reports a combined summary. Returns `true` iff
 * every lane passed; the caller decides how to translate that into an exit
 * code.
 *
 * @param {{
 *   lanes: Array<{ id: string, script: string }>,
 *   label: string,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   concurrency?: number,
 *   spawnFn?: (command: string, args: string[], options: object) => import('node:child_process').ChildProcess,
 *   npmBin?: string,
 *   platform?: string,
 *   log?: (message: string) => void,
 *   logError?: (message: string) => void,
 * }} options
 *   `lanes`, `label`, `concurrency`, `spawnFn`, `npmBin`, and `platform` have
 *   no default value, so -- the same `tsconfig.scripts.json` checkJs:false
 *   footgun `runLane`'s own `@param` comment above documents -- without this
 *   annotation a `.ts` caller's options object would type-check with `lanes`
 *   silently absent from the inferred shape (this is exactly what happened
 *   while writing this module's own test file, caught by `typecheck:scripts`
 *   TS2353, not by any runtime test).
 */
export async function runLanesToCompletion({
  lanes,
  label,
  cwd = process.cwd(),
  env = process.env,
  concurrency,
  spawnFn,
  npmBin,
  platform,
  log = console.log,
  logError = console.error,
} = {}) {
  if (!Array.isArray(lanes) || lanes.length === 0) {
    throw new Error(
      `${label ?? 'npm-lane-aggregate'} runner requires at least one lane`,
    );
  }
  const limit = planConcurrency(lanes.length, { concurrency });
  const results = await mapWithConcurrency(lanes, limit, (lane) =>
    runLane(lane, { cwd, env, spawnFn, npmBin, platform }),
  );
  const summary = summarizeLaneResults(results, { label });
  log(summary.text);
  if (!summary.ok) {
    logError(
      `FAIL: ${label} -- ${summary.failedLaneIds.length} lane(s) failed: ${summary.failedLaneIds.join(', ')}`,
    );
  }
  return summary.ok;
}
