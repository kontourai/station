import { execFileSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

/**
 * station#1101 AC3 static guard: production source must never call the
 * receipt bus's test-only subscribe surface. Complements the runtime
 * `assertTestEnvironment()` guard in `receipt-bus.ts` (which fails fast at
 * call time) with a build-time check that fails the ordinary unit-test
 * gate (`npm test` / `npm run verify:static`) BEFORE a misuse ever ships,
 * rather than only when it happens to execute.
 *
 * Scope: every git-tracked file under `src-server/` that is NOT a test
 * file (`__tests__/**`, `*.test.ts`) or `receipt-bus.ts` itself (which
 * necessarily names its own exports). `src-ui/`, `packages/`, `scripts/`,
 * and `tests/` (Playwright) are out of scope — the receipt bus is a
 * server-only orchestration primitive.
 *
 * Known blind spot: `git grep` (no `--cached`/revision) scans the working
 * tree but, verified empirically, only files git already tracks —
 * a brand-new production file that references the subscribe surface but
 * hasn't been `git add`-ed yet is invisible to this guard until staged.
 * The runtime `assertTestEnvironment()` guard in `receipt-bus.ts` is the
 * backstop for that gap: it throws the moment such a call actually runs,
 * tracked or not.
 */
const SUBSCRIBE_SURFACE = [
  'subscribeForTest',
  'waitForReceipt',
  'resetForTest',
];

const INCLUDE_PATHSPEC = [
  'src-server/',
  ':!src-server/**/__tests__/**',
  ':!src-server/**/*.test.ts',
  ':!src-server/services/infra/receipt-bus.ts',
];

function grepProductionSources(pattern: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['grep', '-I', '-n', '-F', pattern, '--', ...INCLUDE_PATHSPEC],
      { encoding: 'utf8', windowsHide: true },
    );
    return out.trim().split('\n').filter(Boolean);
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      status?: number | null;
    };
    if (execError.status === 1) {
      // git grep's documented "no matches" exit code — the clean case.
      return [];
    }
    // Any other failure (a typo'd/malformed pathspec, git missing, git
    // grep itself erroring) must NOT be silently treated as "no offenders
    // found" — that swallow previously made a broken include pathspec
    // indistinguishable from a genuinely clean repo (both exit 1 with
    // empty stdout when nothing matches, but so does a pathspec that
    // matches nothing because it's wrong). Surface it as a real failure.
    throw error;
  }
}

describe('receipt-bus production-usage guard (station#1101 AC3)', () => {
  test('canary: the include pathspec actually reaches real production files (pins both publish call sites)', () => {
    // Guards against the guard itself: without this, a typo'd
    // `INCLUDE_PATHSPEC` (e.g. a misspelled directory) would make every
    // grep below exit 1 with empty output forever — passing green while
    // scanning nothing. Assert the pathspec finds KNOWN, EXPECTED
    // production matches: the two receiptBus.publish() call sites this
    // feature added, which doubles as a pin that they still exist.
    const knownCallSites = grepProductionSources('receiptBus.publish(');
    expect(knownCallSites.length).toBeGreaterThanOrEqual(2);
    expect(
      knownCallSites.some((line) =>
        line.includes('orchestration-session-state.ts'),
      ),
    ).toBe(true);
    expect(
      knownCallSites.some((line) => line.includes('orchestration-service.ts')),
    ).toBe(true);
  });

  for (const symbol of SUBSCRIBE_SURFACE) {
    test(`no production source file calls receiptBus's "${symbol}"`, () => {
      const offenders = grepProductionSources(symbol);
      expect(
        offenders,
        `Found "${symbol}" referenced outside tests — only test code may ` +
          `subscribe to the receipt bus (see receipt-bus.ts's module doc):\n` +
          offenders.join('\n'),
      ).toEqual([]);
    });
  }
});
