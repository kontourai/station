/**
 * The Windows process identity probe against real processes (#2675).
 *
 * Every other test of `lookupWindowsProcessImageIdentity` replaces PowerShell
 * with a fake, so only this file proves that the script Station sends to
 * Windows PowerShell runs: its start-time function, its re-read, and the
 * Base64 image line that keeps a non-ASCII path intact. It runs in the
 * required Windows job (`npm run test:windows:portable`) and is skipped,
 * visibly, everywhere else.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  lookupProcessBirthFingerprint,
  lookupProcessBirthFingerprintAsync,
  lookupWindowsProcessImageIdentity,
  WINDOWS_BIRTH_HELPER_DIGEST_FILENAME,
} from '@kontourai/station-shared/process-identity';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { stageWindowsBirthHelper } from '../../../../scripts/lib/portable-server-archive.mjs';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import { inspectProcessFingerprint } from '../commands/platform.js';

const WINDOWS = process.platform === 'win32';
// The cold PowerShell budget the probe itself uses, with room for two reads.
const PROBE_TEST_TIMEOUT_MS = 90_000;

const makeTempDir = trackTempDirs();
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  }
});

const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

describe.runIf(WINDOWS)(
  'the Windows identity probe on real processes (runs on win32 only; skipped on this host)',
  () => {
    test(
      'reads this process: its start time is the birth probe’s and two reads agree',
      () => {
        const first = lookupWindowsProcessImageIdentity(process.pid);
        const second = lookupWindowsProcessImageIdentity(process.pid);
        expect(first).not.toBeNull();
        expect(second).toEqual(first);
        expect(first?.birth).toBe(
          lookupProcessBirthFingerprint(process.pid, { timeoutMs: 20_000 }),
        );
        expect(realpathSync.native(first?.image ?? '').toLowerCase()).toBe(
          realpathSync.native(process.execPath).toLowerCase(),
        );
      },
      PROBE_TEST_TIMEOUT_MS,
    );

    test(
      'reads a node.exe under a non-ASCII path exactly, and nothing once it exits',
      async () => {
        // The long, final path: an 8.3 temp prefix would differ from what
        // Windows reports for the started image.
        const root = realpathSync.native(makeTempDir('station-identity-'));
        const directory = join(root, 'Station-José-測試');
        mkdirSync(directory);
        const image = join(directory, 'node.exe');
        copyFileSync(process.execPath, image);
        const child = spawn(image, ['-e', 'setTimeout(() => {}, 120000)'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        children.push(child);
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', () => resolve());
          child.once('error', reject);
        });
        const pid = child.pid as number;

        const first = lookupWindowsProcessImageIdentity(pid);
        const second = lookupWindowsProcessImageIdentity(pid);
        expect(first?.image).toBe(image);
        expect(second).toEqual(first);
        expect(first?.birth).toBe(
          lookupProcessBirthFingerprint(pid, { timeoutMs: 20_000 }),
        );
        expect(inspectProcessFingerprint(pid)).toEqual({
          pid,
          startToken: first?.birth,
          commandDigest: sha256(image),
        });

        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill();
        await exited;
        // Gone: nothing, or, if Windows has already given the pid to another
        // process (the probe's own PowerShell can take it), an identity that
        // is not the child's.
        const after = lookupWindowsProcessImageIdentity(pid);
        expect(after === null || after.birth !== first?.birth).toBe(true);
        const fingerprint = inspectProcessFingerprint(pid);
        expect(
          fingerprint === null || fingerprint.startToken !== first?.birth,
        ).toBe(true);
      },
      PROBE_TEST_TIMEOUT_MS,
    );
  },
);

/**
 * #2805: the precompiled guard a Windows archive stages beside its
 * runtime\node.exe answers the birth probe in place of a cold PowerShell
 * start, and must print exactly what the PowerShell probe prints.
 */
describe.runIf(WINDOWS)(
  'the staged Windows birth helper (runs on win32 only)',
  () => {
    // csc.exe compiles the guard, then the stager runs its own parity check.
    const STAGE_TIMEOUT_MS = 180_000;

    async function startChild(): Promise<number> {
      const child = spawn(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 120000)'],
        { stdio: 'ignore', windowsHide: true },
      );
      children.push(child);
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', reject);
      });
      return child.pid as number;
    }

    /** An archive layout: marker, runtime\node.exe and the staged helper. */
    function stagedArchive() {
      const root = realpathSync.native(makeTempDir('station-birth-helper-'));
      const runtime = join(root, 'runtime');
      mkdirSync(runtime);
      writeFileSync(
        join(root, '.station-prebuilt-archive'),
        'station-prebuilt-archive-v1\n',
      );
      const { helper } = stageWindowsBirthHelper(runtime);
      return { root, helper, execPath: join(runtime, 'node.exe') };
    }

    function recordingExec() {
      const commands: string[] = [];
      const exec = vi.fn(
        (file: string, args: readonly string[], options?: object) => {
          commands.push(file);
          return execFileSync(
            file,
            args,
            options as never,
          ) as unknown as string;
        },
      );
      return { commands, exec };
    }

    test(
      'the helper and the PowerShell probe print the same birth for one pid',
      async () => {
        const { helper } = stagedArchive();
        const pid = await startChild();
        const helperBirth = execFileSync(helper, ['--identity', String(pid)], {
          encoding: 'utf8',
          windowsHide: true,
        }).trim();
        expect(helperBirth).toBe(
          lookupProcessBirthFingerprint(pid, { timeoutMs: 20_000 }),
        );
      },
      STAGE_TIMEOUT_MS,
    );

    test(
      'the birth probe of an archive runtime runs the verified helper, not PowerShell',
      async () => {
        const { helper, execPath } = stagedArchive();
        const pid = await startChild();
        const expected = lookupProcessBirthFingerprint(pid, {
          timeoutMs: 20_000,
        });
        const sync = recordingExec();
        expect(
          lookupProcessBirthFingerprint(pid, { execPath, exec: sync.exec }),
        ).toBe(expected);
        expect(sync.commands).toEqual([helper]);
        const asyncCommands: string[] = [];
        expect(
          await lookupProcessBirthFingerprintAsync(pid, {
            execPath,
            exec: (file, args, options) => {
              asyncCommands.push(file);
              return Promise.resolve(
                execFileSync(file, args, options as never) as unknown as string,
              );
            },
          }),
        ).toBe(expected);
        expect(asyncCommands).toEqual([helper]);
      },
      STAGE_TIMEOUT_MS,
    );

    test(
      'a helper whose digest does not match is never run',
      async () => {
        const { root, helper, execPath } = stagedArchive();
        writeFileSync(
          join(root, 'runtime', WINDOWS_BIRTH_HELPER_DIGEST_FILENAME),
          `${'0'.repeat(64)}\n`,
        );
        const pid = await startChild();
        const sync = recordingExec();
        expect(
          lookupProcessBirthFingerprint(pid, {
            execPath,
            exec: sync.exec,
            timeoutMs: 20_000,
          }),
        ).toBeTruthy();
        expect(sync.commands).not.toContain(helper);
        expect(sync.commands[0]?.toLowerCase()).toContain('powershell');
      },
      STAGE_TIMEOUT_MS,
    );
  },
);
