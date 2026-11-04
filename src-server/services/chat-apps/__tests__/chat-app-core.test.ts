import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DISCORD_CAPABILITIES,
  type DiscordGatewayConfiguration,
} from '@kontourai/station-contracts/discord';
import { orchestrationStorePath } from '@kontourai/station-shared/sqlite-store-integrity';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createLogger } from '../../../utils/logger.js';
import { DiscordAuthorizationService } from '../../discord/discord-authorization.js';
import { DiscordGatewayConfigurationStore } from '../../discord/discord-gateway-config-store.js';
import { DiscordGatewayService } from '../../discord/discord-gateway-service.js';
import { ChatAppCore, splitChatText } from '../chat-app-core.js';

const makeTempDir = trackTempDirs();
const guildId = '1' + '23456789' + '012345678';
const channelId = '2' + '23456789' + '012345678';
const senderId = '3' + '23456789' + '012345678';
const now = '2026-10-27T00:00:00.000Z';

function policy(): DiscordGatewayConfiguration {
  return {
    schemaVersion: 1,
    enabled: true,
    token: 'private-token-never-imported',
    guilds: [{ guildId, channelIds: [channelId] }],
    identities: [
      {
        discordUserId: senderId,
        stationIdentity: 'legacy-owner',
        capabilities: ['turn:start', 'transcript:read', 'project-files:read'],
        projectFileProjects: ['project-a'],
      },
    ],
    sessionBindings: [{ guildId, channelId, sessionId: 'conversation-a' }],
  };
}

function fixture(configuration = policy()) {
  const homeDir = makeTempDir('station-chat-app-core-');
  const config = new DiscordGatewayConfigurationStore(homeDir);
  config.write(configuration);
  const core = new ChatAppCore(homeDir);
  const authorization = new DiscordAuthorizationService(config, core);
  const request = {
    discordUserId: senderId,
    guildId,
    channelId,
    capability: 'turn:start' as const,
  };
  return { homeDir, config, core, authorization, request };
}

class GatewaySocket {
  private readonly listeners = new Map<
    string,
    Array<(...args: unknown[]) => void>
  >();

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  send(): void {}

  close(): void {
    this.emit('close');
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

describe('messaging core at the Discord and SQLite seams', () => {
  test('the kill switch survives reopening the SQLite store', () => {
    const { homeDir, core } = fixture();
    core.setKillSwitch(
      {
        app: 'discord',
        disabled: true,
        updatedAt: now,
        updatedByPrincipalId: 'operator-principal',
      },
      () => true,
    );
    expect(new ChatAppCore(homeDir).isDisabled('discord')).toBe(true);
  });

  test('the persisted kill switch blocks running ingress, outbound delivery and connection after restart', async () => {
    const { homeDir, core } = fixture();
    const socket = new GatewaySocket();
    const executeForegroundMessage = vi
      .fn()
      .mockResolvedValue({ providerTurnId: 'turn-a' });
    const service = new DiscordGatewayService({
      homeDir,
      logger: createLogger({ name: 'chat-core-test' }),
      socketFactory: () => socket,
      executeForegroundMessage,
    });
    service.start();
    try {
      // A second owner writes after the running service has imported its links.
      new ChatAppCore(homeDir).setKillSwitch(
        {
          app: 'discord',
          disabled: true,
          updatedAt: now,
          updatedByPrincipalId: 'operator-principal',
        },
        () => true,
      );
      socket.emit(
        'message',
        JSON.stringify({
          t: 'MESSAGE_CREATE',
          d: {
            id: '4' + '23456789' + '012345678',
            guild_id: guildId,
            channel_id: channelId,
            author: { id: senderId },
            content: 'must not reach orchestration',
          },
        }),
      );
      const send = vi.fn(async () => ({
        externalMessageId: '5' + '23456789' + '012345678',
      }));
      await core.deliver(
        {
          app: 'discord',
          externalWorkspaceId: guildId,
          externalChannelId: channelId,
          direction: 'outbound',
          action: 'notify',
        },
        send,
      );
      expect(executeForegroundMessage).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(core.deliveryLog().map((entry) => entry.outcome)).toEqual([
        { state: 'refused', reason: 'app-disabled' },
        { state: 'refused', reason: 'app-disabled' },
      ]);
    } finally {
      await service.stop();
    }
    const restarted = new ChatAppCore(homeDir);
    expect(restarted.isDisabled('discord')).toBe(true);
    const connect = vi.fn(() => new GatewaySocket());
    const next = new DiscordGatewayService({
      homeDir,
      logger: createLogger({ name: 'chat-core-restart-test' }),
      socketFactory: connect,
    });
    try {
      next.start();
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await next.stop();
    }
  });

  test('an unlinked sender is refused by Discord authorization and retained across restart without a fabricated principal', () => {
    const { homeDir, authorization, request } = fixture();
    expect(
      authorization.authorize({
        ...request,
        discordUserId: '6' + '23456789' + '012345678',
      }),
    ).toEqual({ allowed: false, reason: 'unmapped_identity' });
    const [entry] = new ChatAppCore(homeDir).deliveryLog();
    expect(entry).toMatchObject({
      app: 'discord',
      externalUserId: '6' + '23456789' + '012345678',
      externalWorkspaceId: guildId,
      externalChannelId: channelId,
      direction: 'inbound',
      action: 'continue',
      outcome: { state: 'refused', reason: 'unlinked-sender' },
    });
    expect(entry.principalId).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain('private-token');
  });

  test('a revoked durable link is refused even when the legacy file still grants access and after another import attempt', () => {
    const { homeDir, config, core, authorization, request } = fixture();
    expect(authorization.authorize(request)).toEqual({
      allowed: true,
      stationIdentity: 'legacy-owner',
    });
    expect(core.links.revoke('discord', senderId, now, () => true)).toBe(true);
    core.importLegacyDiscord(config.read(), () => true);
    const restarted = new DiscordAuthorizationService(
      new DiscordGatewayConfigurationStore(homeDir),
    );
    expect(restarted.authorize(request)).toEqual({
      allowed: false,
      reason: 'unmapped_identity',
    });
    expect(core.deliveryLog()[0].outcome).toEqual({
      state: 'refused',
      reason: 'link-revoked',
    });
  });

  test('sets aside unreachable symbolic identifiers while importing usable authority', () => {
    const configuration = policy();
    configuration.identities?.push({
      discordUserId: 'user-a',
      stationIdentity: 'unreachable',
    });
    const { core, authorization, request } = fixture(configuration);
    expect(core.importLegacyDiscord(configuration, () => true)).toEqual({
      imported: true,
      unreachable: { identities: 1, guilds: 0, channels: 0, bindings: 0 },
    });
    expect(authorization.authorize(request)).toEqual({
      allowed: true,
      stationIdentity: 'legacy-owner',
    });
    expect(core.links.lookup('discord', 'user-a').state).toBe('unlinked');
  });

  test('an imported non-canonical revoked mapping remains refused', () => {
    const configuration = policy();
    configuration.identities![0].revokedAt = 'legacy-revoked';
    const { core, authorization, request } = fixture(configuration);
    expect(authorization.authorize(request)).toEqual({
      allowed: false,
      reason: 'unmapped_identity',
    });
    expect(core.links.lookup('discord', senderId).state).toBe('revoked');
    expect(core.deliveryLog()[0].outcome).toEqual({
      state: 'refused',
      reason: 'link-revoked',
    });
  });

  test('imports the exact per-person grants, project slugs, channel allow-list and first-match authority once', () => {
    const configuration = policy();
    configuration.identities?.push(
      {
        discordUserId: '7' + '23456789' + '012345678',
        stationIdentity: 'no-grants',
      },
      {
        discordUserId: '8' + '23456789' + '012345678',
        stationIdentity: 'files-only',
        capabilities: ['project-files:read'],
      },
      {
        discordUserId: '9' + '23456789' + '012345678',
        stationIdentity: 'revoked-first',
        revokedAt: '2099-01-01T00:00:00.000Z',
        capabilities: ['turn:start'],
      },
      {
        discordUserId: '9' + '23456789' + '012345678',
        stationIdentity: 'active-second',
        capabilities: ['turn:start'],
      },
    );
    // Repeated guild scopes are additive in v1; a binding by itself grants nothing.
    configuration.guilds?.push({
      guildId,
      channelIds: ['1' + '33456789' + '012345678'],
    });
    configuration.sessionBindings?.push({
      guildId,
      channelId: '1' + '43456789' + '012345678',
      sessionId: 'unallowlisted-conversation',
    });
    const { core, authorization, request, homeDir, config } =
      fixture(configuration);
    const cases = [
      { capability: 'turn:start', allowed: true, reason: undefined },
      { capability: 'turn:stop', allowed: false, reason: 'not_permitted' },
      { capability: 'transcript:read', allowed: true, reason: undefined },
      {
        capability: 'project-files:read',
        projectSlug: 'project-a',
        allowed: true,
        reason: undefined,
      },
      {
        capability: 'project-files:read',
        projectSlug: 'project-b',
        allowed: false,
        reason: 'not_permitted',
      },
      {
        capability: 'project-files:read',
        allowed: false,
        reason: 'not_permitted',
      },
      {
        capability: 'turn:start',
        channelId: '1' + '33456789' + '012345678',
        allowed: true,
        reason: undefined,
      },
      {
        capability: 'turn:start',
        channelId: '1' + '43456789' + '012345678',
        allowed: false,
        reason: 'outside_allowed_scope',
      },
      {
        capability: 'turn:start',
        guildId: '1' + '53456789' + '012345678',
        allowed: false,
        reason: 'outside_allowed_scope',
      },
      {
        capability: 'turn:start',
        discordUserId: '9' + '23456789' + '012345678',
        allowed: false,
        reason: 'unmapped_identity',
      },
      {
        capability: 'project-files:read',
        discordUserId: '8' + '23456789' + '012345678',
        projectSlug: 'project-a',
        allowed: false,
        reason: 'not_permitted',
      },
    ] as const;
    for (const { allowed, reason, ...overrides } of cases) {
      expect(authorization.authorize({ ...request, ...overrides })).toEqual(
        allowed
          ? { allowed: true, stationIdentity: 'legacy-owner' }
          : { allowed: false, reason },
      );
    }
    for (const capability of DISCORD_CAPABILITIES) {
      expect(
        authorization.authorize({
          ...request,
          discordUserId: '7' + '23456789' + '012345678',
          capability,
        }),
      ).toEqual({ allowed: false, reason: 'not_permitted' });
    }
    expect(core.links.lookup('discord', senderId)).toEqual({
      state: 'linked',
      link: {
        app: 'discord',
        externalUserId: senderId,
        importedAt: expect.any(String),
        provenance: {
          source: 'legacy-import',
          stationIdentity: 'legacy-owner',
          capabilities: ['turn:start', 'transcript:read', 'project-files:read'],
          projectFileProjects: ['project-a'],
        },
      },
    });
    expect(
      core.resolveBinding({
        app: 'discord',
        externalWorkspaceId: guildId,
        externalChannelId: channelId,
      }),
    ).toMatchObject({
      target: { kind: 'conversation', conversationId: 'conversation-a' },
      provenance: { source: 'legacy-import' },
    });

    // Neither a later bootstrap nor a broadened JSON file can reimport grants.
    configuration.identities?.[0].capabilities?.push('turn:stop');
    configuration.identities?.push({
      discordUserId: '1' + '63456789' + '012345678',
      stationIdentity: 'late-user',
      capabilities: ['turn:start'],
    });
    config.write(configuration);
    const restarted = new DiscordAuthorizationService(config);
    expect(
      restarted.authorize({ ...request, capability: 'turn:stop' }),
    ).toEqual({ allowed: false, reason: 'not_permitted' });
    expect(
      restarted.authorize({
        ...request,
        discordUserId: '1' + '63456789' + '012345678',
      }),
    ).toEqual({ allowed: false, reason: 'unmapped_identity' });
    const db = new DatabaseSync(orchestrationStorePath(homeDir), {
      readOnly: true,
    });
    try {
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM chat_app_imports').get()
          ?.count,
      ).toBe(1);
      const records = db
        .prepare(
          'SELECT record FROM chat_app_imports UNION ALL SELECT record FROM chat_identity_links',
        )
        .all();
      expect(JSON.stringify(records)).not.toContain(configuration.token);
    } finally {
      db.close();
    }
    expect(config.read().token).toBe(configuration.token);
  });

  test('live legacy reductions and missing channel lists remain restrictive after import', () => {
    const { core, config, authorization, request } = fixture();
    expect(authorization.authorize(request).allowed).toBe(true);
    for (const guilds of [[{ guildId }], [{ guildId, channelIds: [] }], []]) {
      config.write({ ...policy(), guilds });
      expect(authorization.authorize(request)).toEqual({
        allowed: false,
        reason: 'outside_allowed_scope',
      });
    }
    const changed = policy();
    changed.identities = [{ ...changed.identities![0], capabilities: [] }];
    config.write(changed);
    expect(authorization.authorize(request)).toEqual({
      allowed: false,
      reason: 'not_permitted',
    });
    expect(core.links.lookup('discord', senderId).state).toBe('linked');

    const empty = fixture({ ...policy(), guilds: [{ guildId }] });
    expect(empty.authorization.authorize(empty.request)).toEqual({
      allowed: false,
      reason: 'outside_allowed_scope',
    });
    empty.config.write(policy());
    expect(empty.authorization.authorize(empty.request)).toEqual({
      allowed: false,
      reason: 'outside_allowed_scope',
    });
  });

  test('management writes roll back when operator authority changes before commit', () => {
    const { core } = fixture();
    let rechecks = 0;
    expect(() =>
      core.setKillSwitch(
        {
          app: 'discord',
          disabled: true,
          updatedAt: now,
          updatedByPrincipalId: 'operator-principal',
        },
        () => ++rechecks === 1,
      ),
    ).toThrow('authority changed');
    expect(core.isDisabled('discord')).toBe(false);
  });

  test('delivery receipts retain pending and terminal outcomes and never retry an uncertain send', async () => {
    const { core, homeDir } = fixture();
    const context = {
      app: 'discord' as const,
      externalWorkspaceId: guildId,
      externalChannelId: channelId,
      direction: 'outbound' as const,
      action: 'notify' as const,
    };
    const send = vi.fn(async () => ({
      externalMessageId: '4' + '23456789' + '012345678',
    }));
    await core.deliver(context, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(new ChatAppCore(homeDir).deliveryLog()[0].outcome).toEqual({
      state: 'delivered',
      externalMessageId: '4' + '23456789' + '012345678',
    });
    const noReceipt = vi.fn(async () => {});
    await core.deliver(context, noReceipt);
    expect(noReceipt).toHaveBeenCalledTimes(1);
    expect(core.deliveryLog()[0].outcome).toEqual({ state: 'pending' });
    const failed = vi.fn(async () => {
      throw new Error('secret provider text');
    });
    await expect(core.deliver(context, failed)).rejects.toThrow(
      'Chat message delivery failed',
    );
    expect(failed).toHaveBeenCalledTimes(1);
    expect(core.deliveryLog()[0].outcome).toEqual({
      state: 'failed',
      reason: 'transport-delivery-failed',
    });
    expect(JSON.stringify(core.deliveryLog())).not.toContain(
      'secret provider text',
    );
  });
});

describe('chat text boundaries', () => {
  test.each([
    ['a'.repeat(1999) + '😀z', 2000, ['a'.repeat(1999), '😀z']],
    ['a'.repeat(1998) + '😀z', 2000, ['a'.repeat(1998) + '😀', 'z']],
    ['😀😀😀', 3, ['😀', '😀', '😀']],
    ['a'.repeat(1998) + '👩‍💻Z', 2000, ['a'.repeat(1998), '👩‍💻Z']],
    ['a\u0301\u0301\u0301', 2, ['a\u0301', '\u0301\u0301']],
    ['', 2000, []],
  ] as const)(
    'splits case %# at UTF-16 limits without breaking code points',
    (text, limit, expected) => {
      const chunks = Array.from(splitChatText(text, limit));
      expect(chunks).toEqual(expected);
      expect(chunks.join('')).toBe(text);
      expect(chunks.every((chunk) => chunk.length <= limit)).toBe(true);
      expect(chunks.flatMap((chunk) => Array.from(chunk))).toEqual(
        Array.from(text),
      );
    },
  );

  test('rejects a limit smaller than a code point', () => {
    expect(() => Array.from(splitChatText('😀', 1))).toThrow('code point');
  });
});

// Exercise the gateway through its socket and completion-event seams.
async function reviewFlush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}
function reviewMessage(socket: GatewaySocket, messageId: string) {
  socket.emit(
    'message',
    JSON.stringify({
      t: 'MESSAGE_CREATE',
      d: {
        id: messageId,
        guild_id: guildId,
        channel_id: channelId,
        author: { id: senderId },
        content: 'synthetic review message',
      },
    }),
  );
}

test('busy ingress has a durable inbound refusal', async () => {
  const { homeDir } = fixture();
  const socket = new GatewaySocket();
  let finish!: (value: { providerTurnId: string }) => void;
  const pending = new Promise<{ providerTurnId: string }>((resolve) => {
    finish = resolve;
  });
  const execute = vi.fn(() => pending);
  const send = vi.fn(async () => ({ externalMessageId: '8'.repeat(18) }));
  const service = new DiscordGatewayService({
    homeDir,
    logger: createLogger({ name: 'review-probe' }),
    socketFactory: () => socket,
    executeForegroundMessage: execute,
    deliverMessage: send,
  });
  try {
    service.start();
    reviewMessage(socket, '4'.repeat(18));
    reviewMessage(socket, '5'.repeat(18));
    await reviewFlush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toBeDefined();
    const entries = new ChatAppCore(homeDir).deliveryLog();
    const refusal = entries.find(
      (entry) =>
        entry.direction === 'inbound' && entry.outcome.state === 'refused',
    );
    expect(refusal?.outcome).toEqual({ state: 'refused', reason: 'busy' });
    expect(
      entries.filter(
        (entry) =>
          entry.direction === 'inbound' && entry.outcome.state === 'pending',
      ),
    ).toHaveLength(1);
    expect(
      entries.find((entry) => entry.direction === 'outbound')?.refusalId,
    ).toBe(refusal?.id);
  } finally {
    finish({ providerTurnId: 'review-turn' });
    await reviewFlush();
    await service.stop();
  }
});

test('a long Discord response is delivered in full as bounded chunks', async () => {
  const { homeDir } = fixture();
  const socket = new GatewaySocket();
  let emit!: (event: { event: string; data?: Record<string, unknown> }) => void;
  const delivered: string[] = [];
  const transcript = 'x'.repeat(2001);
  const service = new DiscordGatewayService({
    homeDir,
    logger: createLogger({ name: 'review-probe' }),
    socketFactory: () => socket,
    executeForegroundMessage: async () => ({ providerTurnId: 'review-turn' }),
    eventBus: {
      subscribe(listener) {
        emit = listener;
        return () => {};
      },
    },
    readTranscript: () => transcript,
    deliverMessage: async ({ content }) => {
      delivered.push(content);
      return { externalMessageId: '8'.repeat(18) };
    },
  });
  try {
    service.start();
    reviewMessage(socket, '4'.repeat(18));
    await reviewFlush();
    const { SERVER_EVENTS } = await import(
      '@kontourai/station-contracts/runtime-events'
    );
    emit({
      event: SERVER_EVENTS.ORCHESTRATION_EVENT,
      data: { event: { method: 'turn.completed', turnId: 'review-turn' } },
    });
    await reviewFlush();
    expect(delivered.map((s) => s.length)).toEqual([2000, 1]);
    expect(delivered.join('')).toBe(transcript);
    const receipts = new ChatAppCore(homeDir)
      .deliveryLog()
      .filter((entry) => entry.replyChunk)
      .reverse();
    expect(receipts.map((entry) => entry.replyChunk?.chunkIndex)).toEqual([
      0, 1,
    ]);
    expect(receipts.map((entry) => entry.replyChunk?.chunkCount)).toEqual([
      2, 2,
    ]);
  } finally {
    await service.stop();
  }
});

test('chunks preserve grapheme boundaries at the Discord limit', () => {
  const input = 'a'.repeat(1998) + '👩‍💻Z';
  const chunks = Array.from(splitChatText(input, 2000));
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const boundaries = new Set(
    Array.from(
      segmenter.segment(input),
      (part) => part.index + part.segment.length,
    ),
  );
  let offset = 0;
  const splitBoundaries = chunks.map((chunk) => (offset += chunk.length));
  expect(splitBoundaries.every((end) => boundaries.has(end))).toBe(true);
});

test.each(['overflow', 'failure'] as const)(
  'bounded Discord relay: %s',
  async (scenario) => {
    const { homeDir } = fixture();
    const socket = new GatewaySocket();
    let emit!: (event: {
      event: string;
      data?: Record<string, unknown>;
    }) => void;
    const delivered: string[] = [];
    const service = new DiscordGatewayService({
      homeDir,
      logger: createLogger({ name: 'chunk-test' }),
      socketFactory: () => socket,
      executeForegroundMessage: async () => ({ providerTurnId: 'chunk-turn' }),
      eventBus: {
        subscribe(listener) {
          emit = listener;
          return () => {};
        },
      },
      readTranscript: () => 'x'.repeat(scenario === 'overflow' ? 22000 : 4001),
      deliverMessage: async ({ content }) => {
        if (scenario === 'failure' && delivered.length === 1)
          throw new Error('private');
        delivered.push(content);
        return { externalMessageId: '8'.repeat(18) };
      },
    });
    try {
      service.start();
      reviewMessage(socket, '4'.repeat(18));
      await reviewFlush();
      const { SERVER_EVENTS } = await import(
        '@kontourai/station-contracts/runtime-events'
      );
      const event = {
        event: SERVER_EVENTS.ORCHESTRATION_EVENT,
        data: { event: { method: 'turn.completed', turnId: 'chunk-turn' } },
      };
      emit(event);
      await reviewFlush();
      emit(event);
      await reviewFlush();
      const receipts = new ChatAppCore(homeDir)
        .deliveryLog()
        .filter((entry) => entry.replyChunk)
        .reverse();
      if (scenario === 'overflow') {
        expect(delivered).toHaveLength(10);
        expect(delivered.slice(0, 9).join('')).toBe('x'.repeat(18000));
        expect(delivered[9]).toContain('continues in Station');
        expect(delivered[9]).toContain('conversation-a');
        expect(receipts[9].replyChunk?.overflow).toBe(true);
      } else {
        expect(delivered).toHaveLength(1);
        expect(receipts.map((entry) => entry.outcome.state)).toEqual([
          'delivered',
          'failed',
        ]);
        expect(receipts[1].replyChunk?.chunkIndex).toBe(1);
      }
    } finally {
      await service.stop();
    }
  },
);

test.each(['capability', 'kill-switch', 'policy'] as const)(
  'stops a reply when %s is revoked between chunks',
  async (scenario) => {
    const { homeDir, config, core } = fixture();
    const socket = new GatewaySocket();
    let emit!: (event: {
      event: string;
      data?: Record<string, unknown>;
    }) => void;
    const sent: string[] = [];
    const service = new DiscordGatewayService({
      homeDir,
      logger: createLogger({ name: 'chunk-authorization-test' }),
      socketFactory: () => socket,
      executeForegroundMessage: async () => ({ providerTurnId: 'chunk-turn' }),
      eventBus: {
        subscribe(listener) {
          emit = listener;
          return () => {};
        },
      },
      readTranscript: () => 'x'.repeat(4001),
      deliverMessage: async ({ content }) => {
        sent.push(content);
        if (sent.length === 1) {
          if (scenario === 'capability') {
            const current = config.read();
            current.identities![0].capabilities = ['turn:start'];
            config.write(current);
          } else if (scenario === 'policy') {
            writeFileSync(
              join(homeDir, 'security', 'discord-gateway.json'),
              '{',
            );
          } else {
            core.setKillSwitch(
              {
                app: 'discord',
                disabled: true,
                updatedAt: now,
                updatedByPrincipalId: 'operator-principal',
              },
              () => true,
            );
          }
        }
        return { externalMessageId: '8'.repeat(18) };
      },
    });
    try {
      service.start();
      reviewMessage(socket, '4'.repeat(18));
      await reviewFlush();
      const { SERVER_EVENTS } = await import(
        '@kontourai/station-contracts/runtime-events'
      );
      emit({
        event: SERVER_EVENTS.ORCHESTRATION_EVENT,
        data: { event: { method: 'turn.completed', turnId: 'chunk-turn' } },
      });
      await reviewFlush();
      expect(sent.map((part) => part.length)).toEqual([2000]);
      const receipts = new ChatAppCore(homeDir)
        .deliveryLog()
        .filter((entry) => entry.replyChunk)
        .reverse();
      expect(receipts.map((entry) => entry.outcome)).toEqual([
        { state: 'delivered', externalMessageId: '8'.repeat(18) },
        {
          state: 'refused',
          reason:
            scenario === 'capability'
              ? 'capability-unavailable'
              : scenario === 'policy'
                ? 'policy-unavailable'
                : 'app-disabled',
        },
      ]);
      expect(receipts.map((entry) => entry.replyChunk?.chunkIndex)).toEqual([
        0, 1,
      ]);
      expect(receipts[1].replyChunk?.chunkCount).toBe(3);
      expect(JSON.stringify(receipts)).not.toContain('x'.repeat(100));
    } finally {
      await service.stop();
    }
  },
);
