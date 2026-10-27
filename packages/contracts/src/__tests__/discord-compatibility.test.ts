import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  importLegacyDiscordConfiguration,
  parseChatIdentityLink,
} from '@kontourai/station-contracts/chat-app';
import type { DiscordGatewayConfiguration } from '@kontourai/station-contracts/discord';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import { DiscordGatewayConfigurationStore } from '../../../../src-server/services/discord/discord-gateway-config-store.js';

const temp = trackTempDirs();
const guildId = '123456789012345678';
const channelId = '234567890123456789';
const discordUserId = '345678901234567890';
const importedAt = '2026-10-26T12:01:00.000Z';
const revokedAt = '2026-10-26T12:00:00.000Z';

// Written and read by the real legacy store, including its optional v1 fields.
const legacy: DiscordGatewayConfiguration = {
  schemaVersion: 1,
  enabled: true,
  token: 'fixture-bot-token',
  guilds: [
    { guildId, channelIds: [channelId] },
    { guildId: '456789012345678901' },
  ],
  identities: [
    {
      discordUserId,
      stationIdentity: 'legacy-user-id',
      capabilities: [
        'turn:start',
        'turn:stop',
        'transcript:read',
        'project-files:read',
      ],
      projectFileProjects: ['project-slug'],
      revokedAt,
    },
    {
      discordUserId: '567890123456789012',
      stationIdentity: 'other-legacy-user',
    },
  ],
  sessionBindings: [{ guildId, channelId, sessionId: 'conversation-1' }],
};

test('maps real store v1 shapes without invented link metadata, principal ids or grants', () => {
  const store = new DiscordGatewayConfigurationStore(
    temp('station-discord-contract-'),
  );
  store.write(legacy);
  const read = store.read();
  expect(read).toEqual(legacy);
  const imported = importLegacyDiscordConfiguration(read, importedAt);
  expect(imported).toEqual({
    enabled: true,
    links: [
      {
        app: 'discord',
        externalUserId: discordUserId,
        importedAt,
        revokedAt,
        provenance: {
          source: 'legacy-import',
          stationIdentity: 'legacy-user-id',
          capabilities: [
            'turn:start',
            'turn:stop',
            'transcript:read',
            'project-files:read',
          ],
          projectFileProjects: ['project-slug'],
        },
      },
      {
        app: 'discord',
        externalUserId: '567890123456789012',
        importedAt,
        provenance: {
          source: 'legacy-import',
          stationIdentity: 'other-legacy-user',
          capabilities: [],
          projectFileProjects: [],
        },
      },
    ],
    bindings: [
      {
        id: `legacy-discord:${guildId}:${channelId}`,
        app: 'discord',
        externalWorkspaceId: guildId,
        externalChannelId: channelId,
        target: { kind: 'conversation', conversationId: 'conversation-1' },
        provenance: { source: 'legacy-import' },
      },
    ],
    guilds: [
      { guildId, channelIds: [channelId] },
      { guildId: '456789012345678901', channelIds: [] },
    ],
  });
  const importedLink = imported?.links[0];
  expect(importedLink).toBeDefined();
  expect(parseChatIdentityLink(importedLink)).toEqual(importedLink);
  expect(
    parseChatIdentityLink({ ...importedLink, linkedAt: importedAt }),
  ).toBeNull();
  expect(
    parseChatIdentityLink({
      ...importedLink,
      provenance: { ...importedLink?.provenance, extra: true },
    }),
  ).toBeNull();
  // The private store and token remain unchanged; the projection is not a new writer.
  expect(store.read()).toEqual(legacy);
});

test('preserves first-match ordering, deny-by-default scopes and refuses unrepresentable imports', () => {
  const store = new DiscordGatewayConfigurationStore(
    temp('station-discord-empty-'),
  );
  store.write({ schemaVersion: 1 });
  expect(importLegacyDiscordConfiguration(store.read(), importedAt)).toEqual({
    enabled: false,
    links: [],
    bindings: [],
    guilds: [],
  });
  store.write({
    ...legacy,
    identities: [
      { discordUserId, stationIdentity: 'first', capabilities: [] },
      {
        discordUserId,
        stationIdentity: 'second',
        capabilities: ['turn:start'],
      },
    ],
  });
  const imported = importLegacyDiscordConfiguration(store.read(), importedAt);
  expect(
    imported?.links.map((link) => link.provenance?.stationIdentity),
  ).toEqual(['first', 'second']);
  for (const configuration of [
    {
      ...legacy,
      identities: [
        { discordUserId: 'old-invalid-id', stationIdentity: 'legacy-user-id' },
      ],
    },
    {
      ...legacy,
      identities: [
        {
          discordUserId,
          stationIdentity: 'legacy-user-id',
          revokedAt: 'invalid-date',
        },
      ],
    },
    { ...legacy, guilds: [{ guildId, channelIds: ['invalid-channel'] }] },
    {
      ...legacy,
      sessionBindings: [
        { guildId, channelId: 'invalid-channel', sessionId: 'conversation-1' },
      ],
    },
  ]) {
    store.write(configuration);
    expect(
      importLegacyDiscordConfiguration(store.read(), importedAt),
    ).toBeNull();
  }
  store.write({ ...legacy, enabled: false });
  expect(
    importLegacyDiscordConfiguration(store.read(), importedAt)?.enabled,
  ).toBe(false);
  expect(importLegacyDiscordConfiguration(legacy, 'invalid-time')).toBeNull();
});

test('legacy store keeps permissive extra-key compatibility and refuses unknown schema versions', () => {
  const home = temp('station-discord-extra-');
  const store = new DiscordGatewayConfigurationStore(home);
  const future = { ...legacy, futureKey: true };
  store.write(future);
  expect(store.read()).toEqual(future);
  writeFileSync(
    join(home, 'security', 'discord-gateway.json'),
    JSON.stringify({ ...legacy, schemaVersion: 2 }),
  );
  expect(() => store.read()).toThrow(
    'Discord gateway configuration is unavailable.',
  );
});
