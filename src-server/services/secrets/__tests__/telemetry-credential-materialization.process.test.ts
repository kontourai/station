import { readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { materializeTelemetryCredential } from '../../../domain/telemetry-credential-materialization.js';

const makeTempDir = trackTempDirs();

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test
  .skipIf(process.platform === 'win32')
  .each(['cancellation', 'deadline'] as const)(
  'bounded Datum materialization preserves the key only in the caller and terminates its stalled CLI on %s',
  async (stop) => {
    const root = makeTempDir('station-telemetry-secret-process-');
    const marker = join(root, 'owned-op-pid');
    await writeFile(
      join(root, 'op'),
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
if (process.argv[3] === 'op://fixture/key/value') {
  process.stdout.write(process.env.STATION_INTERNAL_API_TOKEN ? 'unexpected-internal-secret' : 'private-material\\n');
} else setInterval(() => {}, 1000);
`,
      { mode: 0o700 },
    );
    const environment = {
      ...process.env,
      PATH: [root, dirname(process.execPath), process.env.PATH]
        .filter(Boolean)
        .join(delimiter),
      STATION_INTERNAL_API_TOKEN: 'parent-only-internal-secret',
      STATION_PRODUCT_TELEMETRY_KEY: 'unrelated-product-key',
    };
    let stalledPid: number | undefined;
    try {
      const value = await materializeTelemetryCredential(
        { op: 'op://fixture/key/value' },
        environment,
      );
      expect(value).toBe('private-material');
      const successfulPid = Number(await readFile(marker, 'utf8'));
      expect(alive(successfulPid)).toBe(false);
      await rm(marker);
      const controller = new AbortController();
      const request = materializeTelemetryCredential(
        { op: 'op://fixture/stalled/value' },
        environment,
        controller.signal,
      );
      const observed = request.then(
        () => 'accepted',
        () => 'refused',
      );
      await expect
        .poll(
          async () => {
            try {
              stalledPid = Number(await readFile(marker, 'utf8'));
              return stalledPid;
            } catch {
              return undefined;
            }
          },
          { timeout: 5000 },
        )
        .not.toBeUndefined();
      expect(alive(stalledPid!)).toBe(true);
      if (stop === 'cancellation') controller.abort();
      expect(await observed).toBe('refused');
      expect(alive(stalledPid!)).toBe(false);
    } finally {
      if (stalledPid !== undefined && alive(stalledPid)) {
        process.kill(stalledPid, 'SIGKILL');
        await expect
          .poll(() => alive(stalledPid!), { timeout: 5000 })
          .toBe(false);
      }
    }
  },
);
