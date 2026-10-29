/**
 * #561: every owned-process registration records the owner's birth. That
 * owner is this process, whose birth cannot change, yet each registration
 * used to run a fresh synchronous probe (a `ps` on macOS, a `/proc` read on
 * Linux) after the child was already spawned. Station's own birth is read
 * once and reused.
 *
 * The probe primitives are wrapped pass-through so the test counts real
 * probes of this process. It spawns one detached sleeper per registration,
 * killed by exact pid, so it is classified process-heavy in
 * `scripts/vitest-resource-manifest.mjs`.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

const ownProbes = vi.hoisted(() => ({ count: 0 }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFileSync = ((...args: Parameters<typeof actual.execFileSync>) => {
    const [command, argv] = args as [string, readonly string[] | undefined];
    if (
      command === 'ps' &&
      argv?.includes('lstart=') &&
      argv.includes(String(process.pid))
    ) {
      ownProbes.count += 1;
    }
    return actual.execFileSync(...args);
  }) as typeof actual.execFileSync;
  return { ...actual, default: { ...actual, execFileSync }, execFileSync };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    if (args[0] === `/proc/${process.pid}/stat`) ownProbes.count += 1;
    return actual.readFileSync(...args);
  }) as typeof actual.readFileSync;
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

const { spawn } = await import('node:child_process');
const { existsSync, readFileSync } = await import('node:fs');
const { join } = await import('node:path');
const { clearProcessBirthFingerprintCache } = await import(
  '@kontourai/station-shared/process-identity'
);
const { trackTempDirs } = await import('../../../__test-utils__/temp-dirs.js');
const { registerDetachedOwnedChild } = await import('../process-utils.js');

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'owned-process owner birth (#561)',
  () => {
    const makeTempDir = trackTempDirs();
    const children: ReturnType<typeof spawn>[] = [];

    afterEach(async () => {
      for (const child of children.splice(0)) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const exited = new Promise<void>((resolve) =>
          child.once('exit', () => resolve()),
        );
        child.kill('SIGKILL');
        await exited;
      }
      vi.unstubAllEnvs();
    });

    function sleeper() {
      const child = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 86400000)'],
        { stdio: 'ignore', detached: true },
      );
      children.push(child);
      return child;
    }

    test("registrations probe this process's own birth once and reuse it", () => {
      const registryDir = makeTempDir('station-owner-birth-registry-');
      vi.stubEnv('STATION_OWNED_PROCESS_REGISTRY', registryDir);
      clearProcessBirthFingerprintCache();
      ownProbes.count = 0;

      const first = sleeper();
      registerDetachedOwnedChild(first, 'owner-birth test');
      const second = sleeper();
      registerDetachedOwnedChild(second, 'owner-birth test');

      const owners = [first, second].map((child) => {
        const file = join(registryDir, `engine-${child.pid}.json`);
        expect(existsSync(file)).toBe(true);
        return JSON.parse(readFileSync(file, 'utf8')).owner;
      });
      expect(owners[0].pid).toBe(process.pid);
      expect(owners[0].birth).toEqual(expect.any(String));
      expect(owners[1].birth).toBe(owners[0].birth);
      expect(ownProbes.count).toBe(1);
    });
  },
);
