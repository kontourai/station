import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  countBareRandomUUIDCalls,
  EXEMPT_FILES,
  evaluate,
  listScannedFiles,
  SCAN_PATHSPECS,
  SCOPE_SENTINELS,
} from '../random-uuid-guard.mjs';

const count = (source: string) =>
  countBareRandomUUIDCalls(['sample.ts'], () => source).reduce(
    (total, occurrence) => total + occurrence.count,
    0,
  );

describe('random-uuid guard source matching', () => {
  test.each([
    'const requestId = crypto.randomUUID();',
    'const id = { operationId: input.operationId ?? crypto.randomUUID() };',
    'const instanceId = globalThis.crypto.randomUUID();',
  ])('catches the bare call: %s', (source) => {
    expect(count(source)).toBe(1);
  });

  test('counts more than one bare call on the same line', () => {
    expect(
      count('const a = crypto.randomUUID(); const b = crypto.randomUUID();'),
    ).toBe(2);
  });

  test('does not flag the helper it exists to require', () => {
    expect(
      count(
        "import { randomCorrelationId } from '@kontourai/station-shared/random-id';",
      ),
    ).toBe(0);
    expect(count('const id = randomCorrelationId();')).toBe(0);
  });

  test('does not flag an already-guarded optional-chained call', () => {
    expect(
      count('const id = globalThis.crypto?.randomUUID?.() ?? fallbackId();'),
    ).toBe(0);
  });

  test('does not flag an already-guarded typeof-checked call', () => {
    expect(
      count(
        "if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();",
      ),
    ).toBe(0);
  });
});

describe('random-uuid guard scope honesty', () => {
  test('every sentinel is inside the scanned set', () => {
    const files = listScannedFiles();
    for (const sentinel of SCOPE_SENTINELS) {
      expect(files).toContain(sentinel);
    }
  });

  test('a lost sentinel fails rather than reporting green', () => {
    expect(evaluate([], ['src-ui/src/a.ts'])).toMatchObject({ ok: false });
  });

  test('the scanned set is the tracked sources across every pathspec, minus tests and exemptions', () => {
    // An independent re-derivation: a bug in the gate's own lister must not be
    // able to agree with itself (station#1559 class).
    const tracked = execFileSync('git', ['ls-files', '--', ...SCAN_PATHSPECS], {
      encoding: 'utf8',
      windowsHide: true,
    })
      .split('\n')
      .filter((line) => /\.(ts|tsx|mjs|js)$/.test(line))
      .filter((line) => !line.includes('__tests__'))
      .filter((line) => !EXEMPT_FILES.includes(line));

    expect([...listScannedFiles()].sort()).toEqual(tracked.sort());
  });

  test('the repo is at zero, which is the whole point of station#1137', () => {
    const files = listScannedFiles();
    expect(evaluate(countBareRandomUUIDCalls(files), files)).toMatchObject({
      total: 0,
      ok: true,
    });
  });
});

/**
 * The gate's REJECTION path, run as a real child process against a throwaway
 * git repository. A guardrail whose refusal has never executed is unproven:
 * the pure functions above say what it DECIDES, and only these say what it
 * does with that decision — the `FAIL:` sentence and, critically, the exit
 * status. Bounded, single-shot children; classified process-heavy in
 * `scripts/vitest-resource-manifest.mjs` for exactly that reason.
 */
describe('random-uuid guard at the process boundary', () => {
  const GUARD = resolve(import.meta.dirname, '../random-uuid-guard.mjs');
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function repoWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'random-uuid-guard-'));
    created.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), contents);
    }
    execFileSync('git', ['add', '-A'], { cwd: dir, windowsHide: true });
    return dir;
  }

  /** Every sentinel present and clean, so only the injected file can decide. */
  const cleanSentinels = Object.fromEntries(
    SCOPE_SENTINELS.map((path) => [
      path,
      'export const ok = randomCorrelationId();\n',
    ]),
  );

  function runGuard(dir: string) {
    return spawnSync(process.execPath, [GUARD], {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
    });
  }

  test('exits 0 and names its scope when nothing calls crypto.randomUUID bare', () => {
    const run = runGuard(repoWith(cleanSentinels));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('OK: 0 bare crypto.randomUUID() calls');
  });

  test('exits 1 and names the offending file when one regrows', () => {
    const run = runGuard(
      repoWith({
        ...cleanSentinels,
        'src-ui/src/regressed.ts': 'export const id = crypto.randomUUID();\n',
      }),
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('FAIL: 1 bare crypto.randomUUID() call(s)');
    expect(run.stderr).toContain('src-ui/src/regressed.ts: 1');
  });

  test('exits 1 when the pathspec stops matching a sentinel', () => {
    const withoutOne = { ...cleanSentinels };
    delete withoutOne[SCOPE_SENTINELS[0]];
    const run = runGuard(repoWith(withoutOne));
    // Vacuously green is the failure mode this guards: a smaller tree has to
    // fail loudly rather than report zero occurrences over nothing.
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('scope lost these files');
    expect(run.stderr).toContain(SCOPE_SENTINELS[0]);
  });
});
