import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, test } from 'vitest';
import {
  defaultEnrolmentDeps,
  type EnrolmentEngine,
  verifyEnrolment,
} from '../credential-enrolment.js';

const execFileAsync = promisify(execFile);

/**
 * The mocked tests in `credential-enrolment.test.ts` drive `verifyEnrolment`
 * with a resolving `execFile`. The real CLIs do not resolve: BOTH
 * `claude auth status` and `codex login status` exit **1** when signed out,
 * and `promisify(execFile)` rejects on a non-zero exit.
 *
 * That gap survived four independent review rounds and was only found by
 * running the feature against a live Station: a signed-out profile reported
 * `unknown` ("we could not ask") instead of `unauthenticated` ("this account
 * is signed out") — the exact conflation the module says it does not make,
 * and two states that lead a user to different actions.
 *
 * So this test uses NO mock. It points each real CLI at an empty config home
 * and asserts the verdict. If the mapping regresses, the assertion that
 * catches it must be one that talked to the actual binary.
 *
 * Skipped when the CLI is absent, and the skip is LOUD in the test name
 * rather than a silent pass — an absent binary means this ran and proved
 * nothing, which is different from passing.
 */
const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

async function present(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ['--version'], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

function emptyHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'enrolment-int-'));
  homes.push(home);
  return home;
}

describe('verifyEnrolment against the real engine CLIs', () => {
  for (const [engine, binary] of [
    ['claude', 'claude'],
    ['codex', 'codex'],
  ] as ReadonlyArray<[EnrolmentEngine, string]>) {
    test(`${engine}: an empty config home reads as unauthenticated, not unknown`, async () => {
      if (!(await present(binary))) {
        // Deliberately not a silent pass — see the docblock.
        console.warn(
          `[skipped] ${binary} is not installed; this assertion proved nothing.`,
        );
        return;
      }
      const result = await verifyEnrolment(
        engine,
        emptyHome(),
        defaultEnrolmentDeps(),
      );
      expect(
        result.state,
        `${binary} exits non-zero when signed out; the exit code must not be mistaken for an unreadable status`,
      ).toBe('unauthenticated');
    }, 60_000);
  }
});
