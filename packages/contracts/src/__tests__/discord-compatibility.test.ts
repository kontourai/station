import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DiscordGatewayConfiguration } from '@kontourai/station-contracts/discord';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import { DiscordGatewayConfigurationStore } from '../../../../src-server/services/discord/discord-gateway-config-store.js';

const temp = trackTempDirs();

test('existing Discord v1 JSON still parses through the private configuration store', () => {
  const legacy: DiscordGatewayConfiguration = {
    schemaVersion: 1,
    enabled: true,
    token: 'fixture-bot-token',
    guilds: [{ guildId: 'guild-1', channelIds: ['channel-1'] }],
    identities: [
      {
        discordUserId: 'user-1',
        stationIdentity: 'person-1',
        capabilities: [
          'turn:start',
          'turn:stop',
          'transcript:read',
          'project-files:read',
        ],
        projectFileProjects: ['project-1'],
        revokedAt: '2026-10-26T12:00:00.000Z',
      },
    ],
    sessionBindings: [
      {
        guildId: 'guild-1',
        channelId: 'channel-1',
        sessionId: 'conversation-1',
      },
    ],
  };
  const home = temp('station-discord-contract-');
  mkdirSync(join(home, 'security'));
  const path = join(home, 'security', 'discord-gateway.json');
  const store = new DiscordGatewayConfigurationStore(home);
  for (const config of [
    { schemaVersion: 1 },
    legacy,
    { ...legacy, futureKey: true },
  ]) {
    writeFileSync(path, JSON.stringify(config));
    expect(store.read()).toEqual(config);
  }
  writeFileSync(path, JSON.stringify({ ...legacy, schemaVersion: 2 }));
  expect(() => store.read()).toThrow(
    'Discord gateway configuration is unavailable.',
  );
});
