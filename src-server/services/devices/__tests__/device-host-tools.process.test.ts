import { describe, expect, test } from 'vitest';
import { runBoundedToolCapture } from '../device-host-tools.js';

/**
 * #1971 review D1: the Tools drawer's host runner keeps its HARD deadline
 * against REAL processes. `close` waits for every holder of the tool's
 * stdout, so a tool that leaves a descendant behind (`sh -c 'x & y'`) must
 * not be able to hold the call open: the deadline and the output bound
 * settle it themselves. A fake spawn cannot show this — only a real
 * grandchild holds a real pipe.
 *
 * POSIX only (`/bin/sh`); the grandchildren sleep briefly so nothing
 * outlives the file by long. Classified process-heavy in
 * scripts/vitest-resource-manifest.mjs.
 */

const POSIX = process.platform !== 'win32';
const DEADLINE_MS = 300;
/** Deadline plus scheduling slack on a loaded host — far under the 3 s hang. */
const GRACE_MS = 1_500;

async function settleTime(
  run: () => Promise<unknown>,
): Promise<{ ms: number; code: unknown }> {
  const started = Date.now();
  try {
    await run();
    return { ms: Date.now() - started, code: 'resolved' };
  } catch (error) {
    return {
      ms: Date.now() - started,
      code: (error as { code?: unknown }).code,
    };
  }
}

describe('runBoundedToolCapture against real processes (D1)', () => {
  test.for([
    {
      name: 'a grandchild holds stdout while the tool sleeps',
      script: 'sleep 3 & sleep 3',
    },
    {
      name: 'a grandchild holds stdout after the tool wrote and exited',
      script: 'sleep 3 & echo hi',
    },
  ])(
    'the deadline settles as tool-timeout when $name',
    async ({ script }, context) => {
      if (!POSIX) return context.skip('needs /bin/sh');
      const result = await settleTime(() =>
        runBoundedToolCapture('/bin/sh', ['-c', script], {
          timeoutMs: DEADLINE_MS,
        }),
      );
      expect(result.code).toBe('tool-timeout');
      expect(result.ms).toBeLessThan(DEADLINE_MS + GRACE_MS);
    },
  );

  test('overflowing the output bound settles at once, even with a live grandchild', async (context) => {
    if (!POSIX) return context.skip('needs /bin/sh');
    const result = await settleTime(() =>
      runBoundedToolCapture(
        '/bin/sh',
        ['-c', 'sleep 3 & head -c 100000 /dev/zero; sleep 3'],
        // A deadline far away: only the overflow may settle it quickly.
        { timeoutMs: 10_000, maxBuffer: 1024 },
      ),
    );
    expect(result.code).toBe('tool-failed');
    expect(result.ms).toBeLessThan(GRACE_MS);
  });

  test('an ordinary tool still resolves with its output', async (context) => {
    if (!POSIX) return context.skip('needs /bin/sh');
    await expect(
      runBoundedToolCapture('/bin/sh', ['-c', 'echo dark'], {
        timeoutMs: 5_000,
      }),
    ).resolves.toBe('dark\n');
  });
});
