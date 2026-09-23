import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startAccountLabStation } from '../lib/local-collaboration-station.js';

it('does not launch the Station child when private broker config preparation fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'station-config-before-launch-'));
  const directory = join(root, 'station');
  const refused = new Error('fixture_config_write_refused');
  let selectedOrigin: string | undefined;
  try {
    await expect(
      startAccountLabStation(
        {
          directory,
          name: 'config-failure-fixture',
          hostname: '127.0.0.1',
          allowedProbePort: 42101,
          blockedProbePort: 42102,
          probeNonce: 'a'.repeat(64),
          virtualApplicationOrigin: 'http://127.0.0.1:42103',
          prepareSelfHostedBrokerConfig(origin) {
            selectedOrigin = origin;
            throw refused;
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toBe(refused);
    expect(selectedOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(readdirSync(directory).sort()).toEqual(['home', 'os-home', 'tmp']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
