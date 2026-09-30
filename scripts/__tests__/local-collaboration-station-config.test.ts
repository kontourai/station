import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { startAccountLabStation } from '../lib/local-collaboration-station.js';

const makeTempDir = trackTempDirs();

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

it('refuses native Device proof pilot startup without virtual broker ingress', async () => {
  const root = makeTempDir('station-native-proof-config-');
  const directory = join(root, 'station');
  try {
    await expect(
      startAccountLabStation(
        {
          directory,
          name: 'native-proof-config-fixture',
          hostname: '127.0.0.1',
          allowedProbePort: 42111,
          blockedProbePort: 42112,
          probeNonce: 'b'.repeat(64),
          nativeDeviceProofPilot: true,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(
      'Native Device proof pilot requires the fixture virtual application and broker connector.',
    );
    expect(readdirSync(directory).sort()).toEqual(['home', 'os-home', 'tmp']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
