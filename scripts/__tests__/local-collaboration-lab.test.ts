import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localLabEnvironment } from '../lib/local-collaboration-process.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../lib/owned-process.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function run(args: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'station-lab-test-'));
  roots.push(root);
  const execution = executeOwnedCommand(
    process.execPath,
    ['--import', 'tsx', 'scripts/local-collaboration-lab.ts', ...args],
    spawn,
    'local collaboration test',
    {
      cwd: resolve(import.meta.dirname, '../..'),
      windowsHide: true,
      env: { ...localLabEnvironment(), TMPDIR: root, TMP: root, TEMP: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const capture = captureOwnedProcessOutput(execution, {
    maxBytes: 128 * 1024,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      execution.completion,
      new Promise<never>((_, reject) => {
        // This is a liveness ceiling, not an expected response/performance bound.
        timer = setTimeout(
          () => reject(new Error('Lab child exceeded liveness ceiling')),
          90000,
        );
      }),
    ]);
    return { root, result, output: capture.finish() };
  } finally {
    clearTimeout(timer);
    const stopped = await terminateSuiteExecution(execution, {
      waitForSuiteSettlement,
      terminationGraceMs: 2000,
      terminationForceMs: 3000,
      processLabel: 'local collaboration test',
    });
    expect(stopped.settled).toBe(true);
    expect(stopped.errors).toEqual([]);
  }
}

function reportFrom(output: string) {
  const line = output
    .split('\n')
    .find((value) => value.startsWith('STATION_LOCAL_LAB_REPORT '));
  expect(
    line,
    'The actual CLI must produce its report after completing checks',
  ).toBeDefined();
  return JSON.parse(line?.slice('STATION_LOCAL_LAB_REPORT '.length) ?? 'null');
}

function connectionAvailable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(10000, () =>
      socket.destroy(new Error('Listener probe timed out')),
    );
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
  });
}

describe('free local collaboration security lab', () => {
  it('runs real TLS, pairing, negative authorization and relay lifecycle with private disposable state', async () => {
    const unrelated = createServer((socket) => socket.end());
    unrelated.listen(0, '127.0.0.1');
    await once(unrelated, 'listening');
    const address = unrelated.address();
    if (!address || typeof address === 'string')
      throw new Error('Unrelated fixture did not bind');
    let completed: Awaited<ReturnType<typeof run>>;
    try {
      completed = await run(['--check=security', '--keep']);
      expect(await connectionAvailable(address.port)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => unrelated.close(() => resolve()));
    }
    const { root, result, output } = completed;
    expect(result.status, output.stderr.text).toBe(0);
    expect(output.truncated).toBe(false);
    expect(output.invalidUtf8).toBe(false);
    const report = reportFrom(output.stdout.text);
    expect(report.scope).toBe('transport-and-enrollment-fixture');
    expect(report.status).toBe('passed');
    expect(new Set(report.stationIds).size).toBe(2);
    expect(report.ports).toHaveLength(6);
    for (const port of report.ports) {
      expect([3000, 3141]).not.toContain(port);
      expect(await connectionAvailable(port)).toBe(false);
    }
    expect(report.fullScenario.status).toBe('incomplete');
    const homes = readdirSync(root).filter((name) =>
      name.startsWith('station-collaboration-lab-'),
    );
    expect(homes).toHaveLength(1);
    const home = join(root, homes[0]);
    expect(JSON.parse(readFileSync(join(home, 'report.json'), 'utf8'))).toEqual(
      report,
    );
    const aKey = readFileSync(join(home, 'station-a/tls.key'), 'utf8');
    const bKey = readFileSync(join(home, 'station-b/tls.key'), 'utf8');
    expect(aKey).not.toEqual(bKey);
    expect(output.stdout.text).not.toContain('PRIVATE KEY');
    if (process.platform !== 'win32') {
      expect(statSync(home).mode & 0o777).toBe(0o700);
      expect(statSync(join(home, 'station-a/tls.key')).mode & 0o777).toBe(
        0o600,
      );
    }
  }, 120000);

  it('never reports full collaboration complete when only the security fixture is available', async () => {
    const { result, output } = await run(['--check=all']);
    expect(result.status, output.stderr.text).toBe(3);
    const report = reportFrom(output.stdout.text);
    expect(report.fullScenario.status).toBe('incomplete');
    expect(report.fullScenario.missing).toContain(
      'shared-Project membership and guest UI',
    );
  }, 120000);

  it('requires an explicit scope before allocating homes or starting processes', async () => {
    const { root, result } = await run([]);
    expect(result.status).toBe(1);
    expect(
      readdirSync(root).filter((name) =>
        name.startsWith('station-collaboration-lab-'),
      ),
    ).toEqual([]);
  }, 120000);
});
