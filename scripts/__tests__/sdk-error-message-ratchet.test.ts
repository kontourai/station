import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  countHandRolledRefusals,
  EXEMPT_FILES,
  evaluate,
  listScannedFiles,
  SCOPE_SENTINELS,
} from '../sdk-error-message-ratchet.mjs';

const count = (source: string) =>
  countHandRolledRefusals(['sample.ts'], () => source).reduce(
    (total, occurrence) => total + occurrence.count,
    0,
  );

describe('sdk-error-message ratchet source matching', () => {
  test.each([
    "throw new Error(result.error || 'Create failed');",
    "throw new Error(result.error ?? 'Create failed');",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source deliberately embeds a template placeholder
    'throw new Error(payload.error || `HTTP ${response.status}`);',
    "throw new Error(result?.error ?? 'Nope');",
    "throw new Error(j.error || 'Nope');",
  ])('catches the hand-rolled refusal: %s', (source) => {
    expect(count(source)).toBe(1);
  });

  test('catches a nested receiver — the same defect spelled differently', () => {
    expect(count('throw new Error(state.result.error || fallback);')).toBe(1);
    expect(count('throw new Error(read().error || fallback);')).toBe(1);
  });

  test('does not flag the helper call it exists to require', () => {
    expect(
      count("throw new Error(apiErrorMessage(result, 'Create failed'));"),
    ).toBe(0);
  });

  test('does not flag an unrelated `.error` read', () => {
    expect(count('if (result.error) report(result.error);')).toBe(0);
    expect(count('const message = mutation.error?.message;')).toBe(0);
  });
});

describe('sdk-error-message ratchet scope honesty', () => {
  test('every sentinel is inside the scanned set', () => {
    const files = listScannedFiles();
    for (const sentinel of SCOPE_SENTINELS) {
      expect(files).toContain(sentinel);
    }
  });

  test('a lost sentinel fails rather than reporting green', () => {
    expect(evaluate([], ['packages/sdk/src/api.ts'])).toMatchObject({
      ok: false,
    });
  });

  test('the scanned set is the tracked SDK sources minus tests and the helper', () => {
    // An independent re-derivation: a bug in the gate's own lister must not be
    // able to agree with itself (station#1559 class).
    const tracked = execFileSync(
      'git',
      ['ls-files', '--', 'packages/sdk/src'],
      { encoding: 'utf8', windowsHide: true },
    )
      .split('\n')
      .filter((line) => /\.tsx?$/.test(line))
      .filter((line) => !line.includes('__tests__'))
      .filter((line) => !EXEMPT_FILES.includes(line));

    expect([...listScannedFiles()].sort()).toEqual(tracked.sort());
  });

  test('the package is at zero, which is the whole point of #3749', () => {
    const files = listScannedFiles();
    expect(evaluate(countHandRolledRefusals(files), files)).toMatchObject({
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
describe('sdk-error-message ratchet at the process boundary', () => {
  const RATCHET = resolve(
    import.meta.dirname,
    '../sdk-error-message-ratchet.mjs',
  );
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function repoWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'sdk-error-ratchet-'));
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
      "export const ok = apiErrorMessage(result, 'fine');\n",
    ]),
  );

  function runRatchet(dir: string) {
    return spawnSync(process.execPath, [RATCHET], {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
    });
  }

  test('exits 0 and names its scope when nothing hand-rolls a refusal', () => {
    const run = runRatchet(repoWith(cleanSentinels));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('OK: 0 hand-rolled refusal messages');
  });

  test('exits 1 and names the offending file when one regrows', () => {
    const run = runRatchet(
      repoWith({
        ...cleanSentinels,
        'packages/sdk/src/query-domains/regressed.ts':
          "throw new Error(result.error || 'Save failed');\n",
      }),
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('FAIL: 1 hand-rolled refusal message(s)');
    expect(run.stderr).toContain(
      'packages/sdk/src/query-domains/regressed.ts: 1',
    );
  });

  test('exits 1 when the pathspec stops matching a sentinel', () => {
    const withoutOne = { ...cleanSentinels };
    delete withoutOne[SCOPE_SENTINELS[0]];
    const run = runRatchet(repoWith(withoutOne));
    // Vacuously green is the failure mode this guards: a smaller tree has to
    // fail loudly rather than report zero occurrences over nothing.
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('scope lost these files');
    expect(run.stderr).toContain(SCOPE_SENTINELS[0]);
  });
});
