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
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  lookupProcessBirthFingerprint,
  lookupWindowsProcessImageIdentity,
} from '@kontourai/station-shared/process-identity';
import { afterEach, describe, expect, test } from 'vitest';
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
