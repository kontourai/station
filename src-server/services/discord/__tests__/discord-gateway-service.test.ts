import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscordGatewayConfiguration } from '@kontourai/station-contracts/discord';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { activityDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  type DiscordAuthorizationRequest,
  DiscordAuthorizationService,
} from '../discord-authorization.js';
import { DiscordGatewayConfigurationStore } from '../discord-gateway-config-store.js';
import { DiscordGatewayService } from '../discord-gateway-service.js';

class FakeSocket {
  readonly sent: string[] = [];
  private readonly listeners = new Map<
    string,
    Array<(...args: any[]) => void>
  >();

  on(event: string, listener: (...args: any[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.emit('close');
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

class FakeEventBus {
  private listener:
    | ((event: { event: string; data?: Record<string, unknown> }) => void)
    | undefined;

  subscribe(
    listener: (event: {
      event: string;
      data?: Record<string, unknown>;
    }) => void,
  ): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  emitTurnCompleted(
    turnId: string,
    threadId: string,
    outputText: string,
  ): void {
    this.listener?.({
      event: SERVER_EVENTS.ORCHESTRATION_EVENT,
      data: {
        event: {
          method: 'turn.completed',
          turnId,
          threadId,
          outputText,
          eventId: `event-${turnId}`,
          provider: 'test',
          createdAt: '2026-08-16T00:00:00.000Z',
        },
      },
    });
  }
}

const silentLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLogger,
  setLevel: vi.fn(),
  getLevel: () => 'info' as const,
};

const HOME_DIRECTORIES: string[] = [];

function home(): string {
  const directory = mkdtempSync(join(tmpdir(), 'station-discord-gateway-'));
  HOME_DIRECTORIES.push(directory);
  return directory;
}

function configuration(
  overrides: Partial<DiscordGatewayConfiguration> = {},
): DiscordGatewayConfiguration {
  return {
    schemaVersion: 1,
    guilds: [{ guildId: '1'.repeat(18), channelIds: ['2'.repeat(18)] }],
    identities: [],
    ...overrides,
  };
}

function request(
  capability: DiscordAuthorizationRequest['capability'],
): DiscordAuthorizationRequest {
  return {
    discordUserId: '3'.repeat(18),
    guildId: '1'.repeat(18),
    channelId: '2'.repeat(18),
    capability,
  };
}

function emitMessage(
  socket: FakeSocket,
  overrides: Record<string, unknown> = {},
): void {
  socket.emit(
    'message',
    JSON.stringify({
      op: 0,
      t: 'MESSAGE_CREATE',
      d: {
        id: 'message-a',
        content: 'hello Station',
        author: { id: '3'.repeat(18) },
        guild_id: '1'.repeat(18),
        channel_id: '2'.repeat(18),
        ...overrides,
      },
    }),
  );
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of HOME_DIRECTORIES.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

describe('Discord authorization', () => {
  test('refuses an unmapped identity differently from a mapped identity without permission', () => {
    const store = new DiscordGatewayConfigurationStore(home());
    store.write(
      configuration({
        identities: [
          {
            discordUserId: '4'.repeat(18),
            stationIdentity: 'station-user',
          },
        ],
      }),
    );
    const authorization = new DiscordAuthorizationService(store);

    expect(authorization.authorize(request('turn:start'))).toEqual({
      allowed: false,
      reason: 'unmapped_identity',
    });
    expect(
      authorization.authorize({
        ...request('turn:start'),
        discordUserId: '4'.repeat(18),
      }),
    ).toEqual({ allowed: false, reason: 'not_permitted' });
  });

  test('reads the mapping on every request so revocation is immediate', () => {
    const store = new DiscordGatewayConfigurationStore(home());
    store.write(
      configuration({
        identities: [
          {
            discordUserId: '3'.repeat(18),
            stationIdentity: 'station-user',
            capabilities: ['turn:start'],
          },
        ],
      }),
    );
    const authorization = new DiscordAuthorizationService(store);

    expect(authorization.authorize(request('turn:start'))).toEqual({
      allowed: true,
      stationIdentity: 'station-user',
    });

    store.write(
      configuration({
        identities: [
          {
            discordUserId: '3'.repeat(18),
            stationIdentity: 'station-user',
            capabilities: ['turn:start'],
            revokedAt: '2026-08-16T00:00:00.000Z',
          },
        ],
      }),
    );

    expect(authorization.authorize(request('turn:start'))).toEqual({
      allowed: false,
      reason: 'unmapped_identity',
    });
  });

  test('keeps all four capabilities separate and grants nothing by default', () => {
    const store = new DiscordGatewayConfigurationStore(home());
    store.write(
      configuration({
        identities: [
          {
            discordUserId: '3'.repeat(18),
            stationIdentity: 'station-user',
            capabilities: ['turn:start'],
          },
          {
            discordUserId: '5'.repeat(18),
            stationIdentity: 'empty-station-user',
          },
        ],
      }),
    );
    const authorization = new DiscordAuthorizationService(store);

    expect(authorization.authorize(request('turn:start')).allowed).toBe(true);
    for (const capability of [
      'turn:stop',
      'transcript:read',
      'project-files:read',
    ] as const) {
      expect(authorization.authorize(request(capability))).toEqual({
        allowed: false,
        reason: 'not_permitted',
      });
    }
    expect(
      authorization.authorize({
        ...request('turn:start'),
        discordUserId: '5'.repeat(18),
      }),
    ).toEqual({ allowed: false, reason: 'not_permitted' });
  });

  test('requires both the project-files capability and an explicit project scope', () => {
    const store = new DiscordGatewayConfigurationStore(home());
    store.write(
      configuration({
        identities: [
          {
            discordUserId: '3'.repeat(18),
            stationIdentity: 'station-user',
            capabilities: ['project-files:read'],
            projectFileProjects: ['project-a'],
          },
        ],
      }),
    );
    const authorization = new DiscordAuthorizationService(store);

    expect(
      authorization.authorize({
        ...request('project-files:read'),
        projectSlug: 'project-a',
      }),
    ).toEqual({ allowed: true, stationIdentity: 'station-user' });
    expect(
      authorization.authorize({
        ...request('project-files:read'),
        projectSlug: 'project-b',
      }),
    ).toEqual({ allowed: false, reason: 'not_permitted' });
  });
});

describe('DiscordGatewayService', () => {
  test('does not open an outbound connection unless configuration explicitly enables it', () => {
    const sockets: FakeSocket[] = [];
    const service = new DiscordGatewayService({
      homeDir: home(),
      logger: silentLogger,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    service.start();

    expect(sockets).toHaveLength(0);
    expect(service.getGatewayStatus()).toEqual({
      state: 'not-configured',
      reason: 'Discord is not configured or enabled.',
    });
  });

  test('uses the configured gateway ingress to authorize a message and resumes after reconnect', async () => {
    vi.useFakeTimers();
    const directory = home();
    const configurationStore = new DiscordGatewayConfigurationStore(directory);
    configurationStore.write(
      configuration({
        enabled: true,
        token: 'test-token',
        identities: [
          {
            discordUserId: '3'.repeat(18),
            stationIdentity: 'station-user',
            capabilities: ['turn:start'],
          },
        ],
      }),
    );
    const sockets: FakeSocket[] = [];
    const authorizations: unknown[] = [];
    const service = new DiscordGatewayService({
      homeDir: directory,
      logger: silentLogger,
      reconnectDelayMs: 5,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onAuthorization: (result) => authorizations.push(result),
    });

    service.start();
    const first = sockets[0];
    expect(service.getGatewayStatus()).toMatchObject({ state: 'failed' });
    first.emit('open');
    expect(service.getGatewayStatus()).toMatchObject({ state: 'failed' });
    first.emit('message', JSON.stringify({ op: 0, t: 'RESUMED', d: {} }));
    expect(service.getGatewayStatus()).toMatchObject({ state: 'failed' });
    first.emit(
      'message',
      JSON.stringify({ op: 0, t: 'READY', d: { session_id: '' } }),
    );
    expect(service.getGatewayStatus()).toMatchObject({ state: 'failed' });
    first.emit(
      'message',
      JSON.stringify({ op: 10, d: { heartbeat_interval: 1_000 } }),
    );
    expect(service.getGatewayStatus()).toMatchObject({ state: 'failed' });
    expect(JSON.parse(first.sent[0])).toMatchObject({ op: 2 });
    first.emit(
      'message',
      JSON.stringify({
        op: 0,
        s: 7,
        t: 'READY',
        d: {
          session_id: 'gateway-session',
          resume_gateway_url: 'wss://gateway.discord.gg',
        },
      }),
    );
    expect(service.getGatewayStatus()).toMatchObject({ state: 'connected' });
    emitMessage(first);
    await settle();
    expect(authorizations).toEqual([
      { allowed: true, stationIdentity: 'station-user' },
    ]);

    configurationStore.write(
      configuration({
        enabled: true,
        token: 'test-token',
        identities: [
          {
            discordUserId: '3'.repeat(18),
            stationIdentity: 'station-user',
            capabilities: ['turn:start'],
            revokedAt: '2026-08-16T00:00:00.000Z',
          },
        ],
      }),
    );
    emitMessage(first, { id: 'message-b' });
    await settle();
    expect(authorizations).toEqual([
      { allowed: true, stationIdentity: 'station-user' },
      { allowed: false, reason: 'unmapped_identity' },
    ]);

    first.close();
    expect(service.getGatewayStatus()).toMatchObject({ state: 'failed' });
    await vi.advanceTimersByTimeAsync(5);
    const second = sockets[1];
    second.emit(
      'message',
      JSON.stringify({ op: 10, d: { heartbeat_interval: 1_000 } }),
    );
    expect(JSON.parse(second.sent[0])).toMatchObject({
      op: 6,
      d: { session_id: 'gateway-session', seq: 7 },
    });
    second.emit('message', JSON.stringify({ op: 0, t: 'RESUMED', d: {} }));
    expect(service.getGatewayStatus()).toMatchObject({ state: 'connected' });
    second.emit('error');
    expect(service.getGatewayStatus()).toMatchObject({ state: 'failed' });

    second.emit('message', JSON.stringify({ op: 9, d: false }));
    await vi.advanceTimersByTimeAsync(5);
    const third = sockets[2];
    third.emit(
      'message',
      JSON.stringify({ op: 10, d: { heartbeat_interval: 1_000 } }),
    );
    expect(JSON.parse(third.sent[0])).toMatchObject({ op: 2 });

    await service.stop();
    expect(service.getGatewayStatus().state).not.toBe('connected');
  });

  test('starts only mapped, granted channel-bound turns and records the real dispatch handle for relay', async () => {
    const directory = home();
    new DiscordGatewayConfigurationStore(directory).write(
      configuration({
        enabled: true,
        token: 'test-token',
        sessionBindings: [
          {
            guildId: '1'.repeat(18),
            channelId: '2'.repeat(18),
            sessionId: 'session-a',
          },
        ],
        identities: [
          {
            discordUserId: '3'.repeat(18),
            stationIdentity: 'station-user',
            capabilities: ['turn:start'],
          },
          {
            discordUserId: '6'.repeat(18),
            stationIdentity: 'station-ungranted',
          },
        ],
      }),
    );
    const sockets: FakeSocket[] = [];
    const executeForegroundMessage = vi.fn().mockResolvedValue({
      providerTurnId: 'turn-a',
    });
    const delivered: string[] = [];
    const service = new DiscordGatewayService({
      homeDir: directory,
      logger: silentLogger,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      executeForegroundMessage,
      deliverMessage: async ({ content }) => {
        delivered.push(content);
      },
    });

    service.start();
    emitMessage(sockets[0]);
    await settle();
    emitMessage(sockets[0], {
      id: 'message-unmapped',
      author: { id: 'unknown' },
    });
    emitMessage(sockets[0], {
      id: 'message-ungranted',
      author: { id: '6'.repeat(18) },
    });
    await settle();

    expect(executeForegroundMessage).toHaveBeenCalledTimes(1);
    expect(executeForegroundMessage).toHaveBeenCalledWith({
      conversationId: 'session-a',
      message: 'hello Station',
      userId: 'station-user',
      clientTurnId: 'discord:message-a',
    });
    expect(delivered).toEqual([]);
    await service.stop();
  });

  test.each([
    [
      'indeterminate',
      {
        code: 'foreground_message_indeterminate',
        outcome: 'indeterminate',
        message: 'private provider detail',
      },
      'Station could not confirm that this turn started. Do not retry automatically.',
    ],
    [
      'refused',
      new Error('private provider detail'),
      'Station could not start this turn.',
    ],
  ])(
    'acknowledges %s dispatch without exposing content or errors',
    async (_kind, failure, expected) => {
      const directory = home();
      new DiscordGatewayConfigurationStore(directory).write(
        configuration({
          enabled: true,
          token: 'test-token',
          sessionBindings: [
            {
              guildId: '1'.repeat(18),
              channelId: '2'.repeat(18),
              sessionId: 'session-a',
            },
          ],
          identities: [
            {
              discordUserId: '3'.repeat(18),
              stationIdentity: 'station-user',
              capabilities: ['turn:start'],
            },
          ],
        }),
      );
      const socket = new FakeSocket();
      const delivered: string[] = [];
      const executeForegroundMessage = vi.fn().mockRejectedValue(failure);
      const service = new DiscordGatewayService({
        homeDir: directory,
        logger: silentLogger,
        socketFactory: () => socket,
        executeForegroundMessage,
        deliverMessage: async ({ content }) => {
          delivered.push(content);
        },
      });
      service.start();
      emitMessage(socket);
      await settle();
      expect(executeForegroundMessage).toHaveBeenCalledTimes(1);
      expect(delivered).toEqual([expected]);
      await service.stop();
    },
  );

  test('re-resolves revocation on the next message and retains the Station-persisted binding across reconnect', async () => {
    vi.useFakeTimers();
    const directory = home();
    const store = new DiscordGatewayConfigurationStore(directory);
    const base = configuration({
      enabled: true,
      token: 'test-token',
      sessionBindings: [
        {
          guildId: '1'.repeat(18),
          channelId: '2'.repeat(18),
          sessionId: 'session-a',
        },
      ],
      identities: [
        {
          discordUserId: '3'.repeat(18),
          stationIdentity: 'station-user',
          capabilities: ['turn:start'],
        },
      ],
    });
    store.write(base);
    const sockets: FakeSocket[] = [];
    const eventBus = new FakeEventBus();
    const executeForegroundMessage = vi.fn().mockResolvedValue({
      providerTurnId: 'turn-a',
    });
    const service = new DiscordGatewayService({
      homeDir: directory,
      logger: silentLogger,
      reconnectDelayMs: 5,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      executeForegroundMessage,
      eventBus,
      deliverMessage: async () => {},
    });

    service.start();
    emitMessage(sockets[0]);
    await settle();
    eventBus.emitTurnCompleted('turn-a', 'session-a', 'completed');
    await settle();
    sockets[0].close();
    await vi.advanceTimersByTimeAsync(5);
    emitMessage(sockets[1], { id: 'message-after-reconnect' });
    await settle();
    expect(executeForegroundMessage.mock.calls[0]?.[0].conversationId).toBe(
      'session-a',
    );
    expect(executeForegroundMessage.mock.calls[1]?.[0].conversationId).toBe(
      'session-a',
    );
    expect(executeForegroundMessage).toHaveBeenCalledTimes(2);

    store.write(
      configuration({
        ...base,
        identities: [
          {
            discordUserId: '3'.repeat(18),
            stationIdentity: 'station-user',
            capabilities: ['turn:start'],
            revokedAt: '2026-08-16T00:00:00.000Z',
          },
        ],
      }),
    );
    emitMessage(sockets[1], { id: 'message-revoked' });
    await settle();
    expect(executeForegroundMessage).toHaveBeenCalledTimes(2);
    await service.stop();
  });

  test('projects only an acknowledgement without transcript-read, through the completion event relay', async () => {
    const directory = home();
    new DiscordGatewayConfigurationStore(directory).write(
      configuration({
        enabled: true,
        token: 'test-token',
        sessionBindings: [
          {
            guildId: '1'.repeat(18),
            channelId: '2'.repeat(18),
            sessionId: 'session-a',
          },
        ],
        identities: [
          {
            discordUserId: '3'.repeat(18),
            stationIdentity: 'station-user',
            capabilities: ['turn:start'],
          },
        ],
      }),
    );
    const sockets: FakeSocket[] = [];
    const eventBus = new FakeEventBus();
    const delivered: string[] = [];
    const service = new DiscordGatewayService({
      homeDir: directory,
      logger: silentLogger,
      eventBus,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      executeForegroundMessage: async () => ({ providerTurnId: 'turn-a' }),
      readTranscript: () => 'private transcript content',
      deliverMessage: async ({ content }) => {
        delivered.push(content);
      },
    });

    service.start();
    emitMessage(sockets[0]);
    await settle();
    eventBus.emitTurnCompleted(
      'turn-a',
      'session-a',
      'private transcript content',
    );
    await settle();

    expect(delivered).toEqual([
      `Station completed the turn. View it in Station: ${activityDeepLink({ sessionId: 'session-a' })}`,
    ]);
    expect(delivered.join('\n')).not.toContain('private transcript content');
    await service.stop();
  });

  test('delivers complete chunks and refuses concurrent channel turns without using the device-local queue', async () => {
    const directory = home();
    new DiscordGatewayConfigurationStore(directory).write(
      configuration({
        enabled: true,
        token: 'test-token',
        sessionBindings: [
          {
            guildId: '1'.repeat(18),
            channelId: '2'.repeat(18),
            sessionId: 'session-a',
          },
        ],
        identities: [
          {
            discordUserId: '3'.repeat(18),
            stationIdentity: 'station-user',
            capabilities: ['turn:start', 'transcript:read'],
          },
        ],
      }),
    );
    const sockets: FakeSocket[] = [];
    const eventBus = new FakeEventBus();
    const delivered: string[] = [];
    let resolveDispatch:
      | ((value: { providerTurnId: string }) => void)
      | undefined;
    const service = new DiscordGatewayService({
      homeDir: directory,
      logger: silentLogger,
      eventBus,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      executeForegroundMessage: () =>
        new Promise((resolve) => {
          resolveDispatch = resolve;
        }),
      readTranscript: () => `${'A complete sentence. '.repeat(200)}`,
      deliverMessage: async ({ content }) => {
        delivered.push(content);
        return { externalMessageId: '8'.repeat(18) };
      },
    });

    service.start();
    emitMessage(sockets[0]);
    await settle();
    emitMessage(sockets[0], { id: 'message-concurrent' });
    await settle();
    expect(delivered).toEqual([
      'A Station turn is already running for this channel. Please wait for it to finish.',
    ]);

    resolveDispatch?.({ providerTurnId: 'turn-a' });
    await settle();
    eventBus.emitTurnCompleted('turn-a', 'session-a', 'ignored event output');
    await settle();
    await settle();
    expect(delivered).toHaveLength(4);
    expect(delivered.slice(1).join('')).toBe(
      'A complete sentence. '.repeat(200),
    );
    expect(delivered.slice(1).every((chunk) => chunk.length <= 2_000)).toBe(
      true,
    );
    await service.stop();
  });
});
