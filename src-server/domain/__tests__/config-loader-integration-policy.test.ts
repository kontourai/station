// @vitest-environment node

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ConfigLoader } from '../config-loader.js';

const homes: string[] = [];
const integrationId = 'station-control';

function createHome() {
  const home = mkdtempSync(join(tmpdir(), 'station-integration-policy-'));
  homes.push(home);
  mkdirSync(join(home, 'integrations', integrationId), { recursive: true });
  return home;
}

function integrationPath(home: string) {
  return join(home, 'integrations', integrationId, 'integration.json');
}

function writeIntegration(
  home: string,
  value: { enabled?: boolean; disabledTools?: string[] } = {},
) {
  writeFileSync(
    integrationPath(home),
    JSON.stringify({
      id: integrationId,
      kind: 'mcp',
      command: 'station-control',
      ...value,
    }),
  );
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    try {
      chmodSync(integrationPath(home), 0o600);
    } catch {
      // The path may have been deleted or replaced by a symlink in a test.
    }
    rmSync(home, { recursive: true, force: true });
  }
});

describe('ConfigLoader integration publication policy snapshots', () => {
  test('derives policy and witness from one validated integration source', async () => {
    const home = createHome();
    writeIntegration(home, {
      disabledTools: ['station-control_get_task_basis', 'get_task_basis'],
    });
    const loader = new ConfigLoader({ projectHomeDir: home });

    const snapshot =
      await loader.captureIntegrationPolicySnapshot(integrationId);

    expect(snapshot).toMatchObject({
      id: integrationId,
      enabled: true,
      disabledTools: ['get_task_basis', 'station-control_get_task_basis'],
    });
    expect(snapshot?.witness).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(
      snapshot && loader.isIntegrationPolicySnapshotCurrent(snapshot),
    ).toBe(true);
  });

  test.each([
    [
      'is externally edited',
      (home: string) => writeIntegration(home, { enabled: false }),
    ],
    ['is deleted', (home: string) => rmSync(integrationPath(home))],
    [
      'becomes corrupt',
      (home: string) => writeFileSync(integrationPath(home), '{not-json'),
    ],
    [
      'becomes unreadable',
      (home: string) => chmodSync(integrationPath(home), 0o000),
    ],
    [
      'is replaced by a symlink',
      (home: string) => {
        const target = join(home, 'outside-integration.json');
        writeFileSync(
          target,
          JSON.stringify({ id: integrationId, kind: 'mcp' }),
        );
        rmSync(integrationPath(home));
        symlinkSync(target, integrationPath(home));
      },
    ],
  ])(
    'fails closed when the captured policy source %s',
    async (_label, mutate) => {
      const home = createHome();
      writeIntegration(home);
      const loader = new ConfigLoader({ projectHomeDir: home });
      const snapshot =
        await loader.captureIntegrationPolicySnapshot(integrationId);
      expect(snapshot).not.toBeNull();

      mutate(home);

      expect(
        snapshot && loader.isIntegrationPolicySnapshotCurrent(snapshot),
      ).toBe(false);
    },
  );

  test('fails closed while capturing a missing, corrupt, unreadable, or symlinked policy source', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });

    await expect(
      loader.captureIntegrationPolicySnapshot(integrationId),
    ).resolves.toBeNull();

    writeFileSync(integrationPath(home), '{not-json');
    await expect(
      loader.captureIntegrationPolicySnapshot(integrationId),
    ).resolves.toBeNull();

    writeIntegration(home);
    chmodSync(integrationPath(home), 0o000);
    await expect(
      loader.captureIntegrationPolicySnapshot(integrationId),
    ).resolves.toBeNull();
    chmodSync(integrationPath(home), 0o600);

    const target = join(home, 'outside-integration.json');
    writeIntegration(home);
    writeFileSync(target, JSON.stringify({ id: integrationId, kind: 'mcp' }));
    rmSync(integrationPath(home));
    symlinkSync(target, integrationPath(home));
    await expect(
      loader.captureIntegrationPolicySnapshot(integrationId),
    ).resolves.toBeNull();
  });
});
