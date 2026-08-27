import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const supportedPlatform =
  process.platform === 'darwin' || process.platform === 'linux';
const enabled = process.env.STATION_SERVICE_ITEST === '1' && supportedPlatform;

interface ServiceStatus {
  healthy: boolean;
  installed: boolean;
  instance: {
    bootId?: string;
    server: { pid: number | null };
  };
}

function station(args: string[], allowFailure = false) {
  const result = spawnSync('./station', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `station ${args.join(' ')} failed (${result.status}): ${result.stderr}`,
    );
  }
  return result;
}

async function waitForRestart(args: string[], previousBootId: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = station(['service', 'status', ...args, '--json'], true);
    if (result.status === 0) {
      const status = JSON.parse(result.stdout) as ServiceStatus;
      if (status.healthy && status.instance.bootId !== previousBootId)
        return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('managed service did not restart with a new boot identity');
}

async function waitForScheduledOutput(
  job: string,
  apiBase: string,
): Promise<string> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = station(
      ['schedule', 'logs', job, '5', `--api-base=${apiBase}`],
      true,
    );
    if (result.status === 0 && result.stdout.includes('SERVICE_ITEST_OK')) {
      return result.stdout;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    'scheduler did not fire the guarded job with SERVICE_ITEST_OK output',
  );
}

describe.skipIf(!enabled)('station service guarded integration', () => {
  test('install -> status -> kill -> restart -> scheduled job -> uninstall', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-itest-'));
    const instance = `service-itest-${process.pid}`;
    const serverPort = 34_000 + (process.pid % 500);
    const uiPort = serverPort + 1_000;
    const flags = [
      `--instance=${instance}`,
      `--base=${baseDir}`,
      `--port=${serverPort}`,
      `--ui-port=${uiPort}`,
      '--host=127.0.0.1',
    ];
    const apiBase = `http://127.0.0.1:${serverPort}`;
    const job = `service-itest-${process.pid}`;

    try {
      station(['service', 'install', ...flags]);
      const before = JSON.parse(
        station(['service', 'status', ...flags, '--json']).stdout,
      ) as ServiceStatus;
      expect(before).toMatchObject({ healthy: true, installed: true });
      expect(before.instance.server.pid).toEqual(expect.any(Number));

      station([
        'schedule',
        'create',
        `--data=${JSON.stringify({
          agent: 'station',
          cron: '* * * * *',
          name: job,
          prompt: 'Reply exactly SERVICE_ITEST_OK',
        })}`,
        `--api-base=${apiBase}`,
      ]);

      process.kill(before.instance.server.pid as number, 'SIGKILL');
      const after = await waitForRestart(flags, before.instance.bootId ?? '');
      expect(after.instance.bootId).not.toBe(before.instance.bootId);

      const logs = await waitForScheduledOutput(job, apiBase);
      expect(logs).toContain(job);
      expect(logs).toContain('SERVICE_ITEST_OK');
    } finally {
      station(['schedule', 'delete', job, `--api-base=${apiBase}`], true);
      station(['service', 'uninstall', ...flags], true);
      const finalStatus = JSON.parse(
        station(['service', 'status', ...flags, '--json']).stdout,
      ) as ServiceStatus;
      expect(finalStatus.installed).toBe(false);
    }
  }, 180_000);
});
