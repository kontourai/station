import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { STATION_CHANNEL_PORTS_DATA } from '../../packages/shared/src/channel-ports.generated.js';
import { CHANNEL_VERSION } from '../../packages/shared/src/release-manifest.mjs';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  CHANNEL_PORTS,
  checkGeneratedChannelPorts,
  RELEASE_RINGS,
  syncGeneratedChannelPorts,
} from '../channel-ports.mjs';

const root = resolve(import.meta.dirname, '../..');
type ChannelPortAllocation = {
  instanceDirectory: string;
  serverPort: number;
  uiPort: number;
  consentPort: number;
};
const channelPorts = CHANNEL_PORTS as Record<string, ChannelPortAllocation>;
const releaseChannels = ['stable', 'beta', 'nightly'] as const;

const makeTempDir = trackTempDirs();

/** A copy of the checked-in generated consumers, so drift never touches the worktree. */
function generatedTreeCopy() {
  const copy = makeTempDir('station-channel-ports-');
  for (const path of [
    'packages/shared/src/channel-ports.generated.ts',
    'packages/shared/src/release-rings.generated.mjs',
    'packages/shared/src/release-manifest-keys.generated.ts',
    'src-desktop/src/channel_ports_generated.rs',
    'src-desktop/Info.stable.plist',
    'src-desktop/Info.beta.plist',
    'src-desktop/Info.nightly.plist',
  ])
    cpSync(resolve(root, path), join(copy, path));
  return copy;
}

describe('channel port generation', () => {
  test('allocates complete, disjoint channel homes and ports across every generated consumer', () => {
    const allPorts = Object.values(channelPorts).flatMap((entry) => [
      entry.serverPort,
      entry.uiPort,
      entry.consentPort,
    ]);
    const instances = Object.values(channelPorts).map(
      (entry) => entry.instanceDirectory,
    );
    expect(new Set(allPorts).size).toBe(allPorts.length);
    expect(new Set(instances).size).toBe(instances.length);

    expect(STATION_CHANNEL_PORTS_DATA).toEqual(channelPorts);
    const rust = readFileSync(
      resolve(root, 'src-desktop/src/channel_ports_generated.rs'),
      'utf8',
    );
    for (const [channel, ports] of Object.entries(channelPorts)) {
      if (channel !== 'development') {
        expect(rust).toContain(`Some("${channel}")`);
        expect(rust).toContain(
          String(ports.serverPort).replace(/(\d)(?=(\d{3})+$)/g, '$1_'),
        );
        expect(rust).toContain(
          String(ports.consentPort).replace(/(\d)(?=(\d{3})+$)/g, '$1_'),
        );
        expect(
          readFileSync(
            resolve(root, 'src-desktop', `Info.${channel}.plist`),
            'utf8',
          ),
        ).toContain(`<integer>${ports.serverPort}</integer>`);
      }
    }
  });

  test('detects generated TypeScript drift and sync restores the contract', () => {
    const outputRoot = generatedTreeCopy();
    const generated = join(
      outputRoot,
      'packages/shared/src/channel-ports.generated.ts',
    );
    expect(() => checkGeneratedChannelPorts({ outputRoot })).not.toThrow();
    writeFileSync(generated, `${readFileSync(generated, 'utf8')}// drift\n`);
    expect(() => checkGeneratedChannelPorts({ outputRoot })).toThrow(/stale/);
    syncGeneratedChannelPorts({ outputRoot });
    expect(() => checkGeneratedChannelPorts({ outputRoot })).not.toThrow();
  });

  test('detects drift in the shared copy of the pinned manifest keys and sync restores it', () => {
    const outputRoot = generatedTreeCopy();
    const generated = join(
      outputRoot,
      'packages/shared/src/release-manifest-keys.generated.ts',
    );
    const original = readFileSync(generated, 'utf8');
    // The projection carries every pinned key id from the config.
    const config = JSON.parse(
      readFileSync(resolve(root, 'config/release-manifest-keys.json'), 'utf8'),
    ) as { keys: { keyId: string }[] };
    expect(config.keys.length).toBeGreaterThan(0);
    for (const key of config.keys) expect(original).toContain(key.keyId);
    // A swapped key is exactly what this file must never drift into.
    const drifted = original.replace('MCowBQYDK2VwAyEA', 'MCowBQYDK2VwAyEB');
    expect(drifted).not.toBe(original);
    writeFileSync(generated, drifted);
    expect(() => checkGeneratedChannelPorts({ outputRoot })).toThrow(/stale/);
    syncGeneratedChannelPorts({ outputRoot });
    expect(readFileSync(generated, 'utf8')).toBe(original);
  });

  test('detects generated release-ring module drift and sync restores it', () => {
    const outputRoot = generatedTreeCopy();
    const generated = join(
      outputRoot,
      'packages/shared/src/release-rings.generated.mjs',
    );
    const original = readFileSync(generated, 'utf8');
    const drifted = original.replace('prerelease: true', 'prerelease: false');
    expect(drifted).not.toBe(original);
    writeFileSync(generated, drifted);
    expect(() => checkGeneratedChannelPorts({ outputRoot })).toThrow(/stale/);
    syncGeneratedChannelPorts({ outputRoot });
    expect(readFileSync(generated, 'utf8')).toBe(original);
    expect(() => checkGeneratedChannelPorts({ outputRoot })).not.toThrow();
  });

  test('the manifest verifier takes its ring grammar from the generated ring table', async () => {
    // A ring that exists only in the mocked projection proves the verifier
    // reads the table rather than a copy of today's rings.
    vi.resetModules();
    vi.doMock('../../packages/shared/src/release-rings.generated.mjs', () => ({
      STATION_RELEASE_RINGS: {
        stable: {
          runtimeChannel: 'stable',
          prerelease: false,
          launcher: 'station',
        },
        canary: {
          runtimeChannel: 'canary',
          prerelease: true,
          launcher: 'station-canary',
        },
      },
    }));
    try {
      const mocked = await import(
        '../../packages/shared/src/release-manifest.mjs'
      );
      expect(Object.keys(mocked.CHANNEL_VERSION)).toEqual(['stable', 'canary']);
      expect(mocked.CHANNEL_VERSION.canary.test('1.2.3-canary.4')).toBe(true);
      expect(mocked.CHANNEL_VERSION.canary.test('1.2.3')).toBe(false);
    } finally {
      vi.doUnmock('../../packages/shared/src/release-rings.generated.mjs');
      vi.resetModules();
    }

    const rings = RELEASE_RINGS as Record<string, { prerelease: boolean }>;
    expect(Object.keys(CHANNEL_VERSION)).toEqual(Object.keys(rings));
    for (const [ring, { prerelease }] of Object.entries(rings)) {
      expect(CHANNEL_VERSION[ring].test('1.2.3')).toBe(!prerelease);
      expect(CHANNEL_VERSION[ring].test(`1.2.3-${ring}.4`)).toBe(prerelease);
    }
  });

  test('allocates each release channel a contiguous server block and distinct UI port', () => {
    // station#3677: the consent listener is the fourth member of each
    // channel's contiguous reserved block (server, terminal, voice, consent),
    // published explicitly in the contract rather than silently derived.
    const expectedBlocks = {
      stable: [18141, 18142, 18143, 18144, 18000],
      beta: [28141, 28142, 28143, 28144, 28000],
      nightly: [38141, 38142, 38143, 38144, 38000],
    };
    for (const channel of releaseChannels) {
      const { serverPort, uiPort, consentPort } = channelPorts[channel];
      expect(consentPort).toBe(serverPort + 3);
      expect([
        serverPort,
        serverPort + 1,
        serverPort + 2,
        consentPort,
        uiPort,
      ]).toEqual(expectedBlocks[channel]);
    }
  });
});
