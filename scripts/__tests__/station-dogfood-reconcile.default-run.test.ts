import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { defaultRun } from '../station-dogfood-reconcile.mjs';

describe('defaultRun (file-captured output, #1057 wedge regression)', () => {
  it('returns when the direct child exits even if a detached descendant still holds the output fds', async () => {
    // With pipe-based capture this hangs until the backgrounded sleep
    // releases the inherited write end — the exact supervisor wedge from
    // the 2026-07-28 incident (esbuild service daemons under
    // `npm run build:*` with stdio: 'inherit').
    const fixture = mkdtempSync(join(tmpdir(), 'station-default-run-'));
    const pidFile = join(fixture, 'descendant.pid');
    let descendantPid: number | undefined;
    try {
      const startedAt = Date.now();
      const result = defaultRun(
        'sh',
        [
          '-c',
          'echo out-line; echo err-line >&2; sleep 8 & echo $! > "$PID_FILE"; exit 0',
        ],
        { env: { ...process.env, PID_FILE: pidFile } },
      );
      descendantPid = Number(readFileSync(pidFile, 'utf8').trim());
      // Must stay well under the 8s the detached descendant holds the fds —
      // a pipe-based regression blocks the full duration and fails this.
      expect(Date.now() - startedAt).toBeLessThan(4_000);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('out-line');
      expect(result.stderr).toContain('err-line');
    } finally {
      if (Number.isInteger(descendantPid)) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          // The bounded fixture may already have exited.
        }
        const deadline = Date.now() + 1_000;
        while (Date.now() < deadline) {
          try {
            process.kill(descendantPid, 0);
            await new Promise((resolve) => setTimeout(resolve, 10));
          } catch {
            break;
          }
        }
      }
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('honors maxBuffer as an output cap', () => {
    const result = defaultRun('sh', ['-c', 'printf aaaaaaaaaa'], {
      maxBuffer: 4,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('aaaa');
  });

  it('reports a timed-out child as a failure instead of blocking', () => {
    const result = defaultRun('sh', ['-c', 'sleep 5'], { timeoutMs: 300 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ETIMEDOUT|timed? ?out/i);
  });
});
