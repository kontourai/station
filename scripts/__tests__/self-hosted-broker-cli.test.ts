import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';

describe('self-hosted broker CLI', () => {
  test('publishes one private bundle and reuses it on an exact init retry', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-broker-cli-'));
    const configPath = join(root, 'config.json');
    const credentialsPath = join(root, 'credentials.json');
    const databasePath = join(root, 'broker.sqlite');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 'station-self-hosted-broker/v1',
        databasePath,
        credentialsPath,
        port: 0,
        provision: [
          {
            stationId: 'station-12345678',
            enrollmentId: 'enroll-12345678',
            routingGeneration: 1,
            browserOrigin: 'http://localhost:4173',
          },
        ],
      }),
      { mode: 0o600 },
    );
    const run = () =>
      execFileSync(
        resolve('node_modules/.bin/tsx'),
        ['scripts/self-hosted-broker.ts', 'init', configPath],
        { cwd: resolve(import.meta.dirname, '../..'), windowsHide: true },
      );
    run();
    const first = readFileSync(credentialsPath, 'utf8');
    run();
    expect(readFileSync(credentialsPath, 'utf8')).toBe(first);
    const db = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      (
        db.prepare('SELECT count(*) count FROM broker_leases').get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
    db.close();
  });
});
