import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CHANNEL_PORTS,
  checkGeneratedChannelPorts,
  syncGeneratedChannelPorts,
} from '../channel-ports.mjs';

const root = resolve(import.meta.dirname, '../..');
const generatedTypeScript = resolve(
  root,
  'packages/shared/src/channel-ports.generated.ts',
);
type ChannelPortAllocation = {
  instanceDirectory: string;
  serverPort: number;
  uiPort: number;
  consentPort: number;
};
const channelPorts = CHANNEL_PORTS as Record<string, ChannelPortAllocation>;
const releaseChannels = ['stable', 'beta', 'nightly'] as const;

let restoreGenerated: (() => void) | undefined;
afterEach(() => restoreGenerated?.());

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

    const typescript = readFileSync(generatedTypeScript, 'utf8');
    const rust = readFileSync(
      resolve(root, 'src-desktop/src/channel_ports_generated.rs'),
      'utf8',
    );
    for (const [channel, ports] of Object.entries(channelPorts)) {
      expect(typescript).toContain(`${channel}:`);
      expect(typescript).toContain(String(ports.serverPort));
      expect(typescript).toContain(String(ports.uiPort));
      expect(typescript).toContain(String(ports.consentPort));
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
    const original = readFileSync(generatedTypeScript, 'utf8');
    restoreGenerated = () => writeFileSync(generatedTypeScript, original);
    writeFileSync(generatedTypeScript, `${original}// drift\n`);
    expect(() => checkGeneratedChannelPorts()).toThrow(/stale/);
    syncGeneratedChannelPorts();
    expect(() => checkGeneratedChannelPorts()).not.toThrow();
    restoreGenerated = undefined;
  });

  test('projects every release channel port block into Station-owned installer consumers', () => {
    const installer = readFileSync(resolve(root, 'install.sh'), 'utf8');

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
    for (const channel of ['stable', 'beta'] as const) {
      const { serverPort, uiPort } = channelPorts[channel];
      expect(installer).toContain(`runtime_server_port=${serverPort}`);
      expect(installer).toContain(`runtime_ui_port=${uiPort}`);
    }
  });
});
