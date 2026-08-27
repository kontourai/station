import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectProcessFingerprint } from '../../../packages/cli/src/commands/platform.js';

const harnessPath = resolve(
  import.meta.dirname,
  'station-fixture-owner.abnormal-exit-harness.ts',
);

let harness: ChildProcess | undefined;

afterEach(() => {
  if (harness?.exitCode === null && harness?.signalCode === null) {
    try {
      harness.kill('SIGKILL');
    } catch {
      // The harness may exit between the liveness check and SIGKILL.
    }
  }
  harness = undefined;
});

type Fingerprint = NonNullable<ReturnType<typeof inspectProcessFingerprint>>;

function isSameFingerprint(
  actual: ReturnType<typeof inspectProcessFingerprint>,
  expected: Fingerprint,
): boolean {
  return (
    actual?.pid === expected.pid &&
    actual.startToken === expected.startToken &&
    actual.commandDigest === expected.commandDigest
  );
}

async function harnessChild(): Promise<{
  pid: number;
  fingerprint: Fingerprint;
}> {
  harness = spawn(process.execPath, ['--import', 'tsx', harnessPath], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return new Promise<{
    pid: number;
    fingerprint: Fingerprint;
  }>((resolveChild, reject) => {
    const lines = createInterface({ input: harness!.stdout! });
    const onError = (error: Error) => {
      lines.close();
      reject(error);
    };
    lines.once('line', (line) => {
      lines.close();
      harness!.off('error', onError);
      const reported = JSON.parse(line) as {
        pid?: unknown;
        fingerprint?: Fingerprint;
      };
      if (
        !Number.isInteger(reported.pid) ||
        !reported.fingerprint ||
        reported.fingerprint.pid !== reported.pid
      ) {
        reject(new Error(`harness did not report a fingerprint: ${line}`));
        return;
      }
      resolveChild({ pid: reported.pid, fingerprint: reported.fingerprint });
    });
    harness!.once('error', onError);
  });
}

describe('StationFixtureOwner abnormal teardown', () => {
  it('reaps its state-snapshotted child when the fixture worker is SIGTERMed before afterEach', async () => {
    const child = await harnessChild();
    expect(
      isSameFingerprint(
        inspectProcessFingerprint(child.pid),
        child.fingerprint,
      ),
    ).toBe(true);

    harness!.kill('SIGTERM');
    await new Promise<void>((resolveExit) =>
      harness!.once('exit', resolveExit),
    );

    await expect
      .poll(
        () => {
          return isSameFingerprint(
            inspectProcessFingerprint(child.pid),
            child.fingerprint,
          );
        },
        { timeout: 2_000 },
      )
      .toBe(false);
  }, 12_000);
});
