/**
 * The generation registry is best-effort: failing to write it is logged and
 * the supervisor keeps serving. A genuinely unexpected error is logged, the
 * active generation drained, and the supervisor exits nonzero.
 */
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.ts';
import { startSupervisor } from './harness.ts';

const makeTempDir = trackTempDirs();
const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('supervisor resilience (real processes)', () => {
  posixOnly(
    'keeps serving when the generation registry cannot be written',
    async () => {
      const home = makeTempDir('sup-registry-fail-');
      const supervisor = await startSupervisor({ home });
      const run = join(home, 'run');
      chmodSync(run, 0o500);
      try {
        expect(await supervisor.handoff()).toMatchObject({
          outcome: 'committed',
          generation: 2,
        });
        const status = await supervisor.status();
        expect(status.state).toBe('serving');
        expect(status.active?.generation).toBe(2);
        await vi.waitFor(() =>
          expect(supervisor.output()).toContain(
            'could not write the generation registry',
          ),
        );
        expect(supervisor.child.exitCode).toBeNull();
      } finally {
        chmodSync(run, 0o700);
      }
    },
    60_000,
  );

  posixOnly(
    'drains and exits nonzero on an unexpected error instead of dying abruptly',
    async () => {
      const home = makeTempDir('sup-fatal-');
      // Loaded into the supervisor process: throws from a timer on SIGUSR2.
      const injector = join(makeTempDir('sup-fatal-inject-'), 'inject.mjs');
      writeFileSync(
        injector,
        "process.on('SIGUSR2', () => setImmediate(() => { throw new Error('injected fatal for test'); }));\n",
      );
      const supervisor = await startSupervisor({
        home,
        nodeArgs: ['--import', injector],
      });
      const core = (await supervisor.status()).active?.pid as number;
      supervisor.child.kill('SIGUSR2');
      const exit = await supervisor.exited;
      expect(exit, supervisor.output()).toEqual({ code: 1, signal: null });
      expect(supervisor.output()).toContain(
        'fatal: Error: injected fatal for test',
      );
      // The active generation was drained (it exits 0 when drained), not orphaned.
      expect(supervisor.output()).toContain(`generation 1 exited code=0`);
      expect(() => process.kill(core, 0)).toThrow();
    },
    60_000,
  );
});
