import type {
  DiscordChannelSessionBinding,
  DiscordGatewayConfiguration,
} from '@kontourai/station-contracts/discord';
import {
  type CanonicalRuntimeEvent,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import WebSocket from 'ws';
import { discordGatewayEvents } from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';
import type { DiscordAuthorizationResult } from './discord-authorization.js';
import { DiscordAuthorizationService } from './discord-authorization.js';
import {
  DiscordGatewayConfigurationError,
  DiscordGatewayConfigurationStore,
  findDiscordChannelSessionBinding,
} from './discord-gateway-config-store.js';
import { DiscordTurnRelayStore } from './discord-turn-relay-store.js';

const DISCORD_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const DISCORD_GUILD_MESSAGES_INTENT = 1 << 9;

interface GatewaySocket {
  on(
    event: 'open' | 'close' | 'error' | 'message',
    listener: (...args: any[]) => void,
  ): this;
  send(payload: string): void;
  close(): void;
}

export interface DiscordGatewayServiceOptions {
  homeDir: string;
  logger: Logger;
  socketFactory?: (url: string) => GatewaySocket;
  reconnectDelayMs?: number;
  onAuthorization?: (result: DiscordAuthorizationResult) => void;
  /**
   * The same foreground orchestration entrypoint used by interactive callers.
   * Runtime composition supplies `continueExecutionTargetMessage`, which
   * resolves the bound Station session's persisted execution target before it
   * enters `executeForegroundMessage`.
   */
  executeForegroundMessage?: (input: {
    conversationId: string;
    message: string;
    userId: string;
    clientTurnId: string;
  }) => Promise<{ providerTurnId: string }>;
  /** Reads the canonical Station transcript projection for one completed turn. */
  readTranscript?: (input: { sessionId: string; turnId: string }) => string;
  deliverMessage?: (input: {
    token: string;
    channelId: string;
    content: string;
  }) => Promise<void>;
  eventBus?: {
    subscribe(
      listener: (event: {
        event: string;
        data?: Record<string, unknown>;
      }) => void,
    ): () => void;
  };
}

type GatewayEnvelope = {
  op?: unknown;
  d?: unknown;
  s?: unknown;
  t?: unknown;
};

function recordGatewayEvent(outcome: string): void {
  try {
    discordGatewayEvents.add(1, { outcome });
  } catch {
    // Metrics must never affect connection or authorization behavior.
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function gatewayResumeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'wss:' || url.hostname !== 'gateway.discord.gg') {
      return undefined;
    }
    url.searchParams.set('v', '10');
    url.searchParams.set('encoding', 'json');
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Outbound-only, resumable Discord Gateway transport. It never writes a
 * Station session. In this slice, MESSAGE_CREATE proves the real ingress seam
 * reaches authorization and then stops; later slices own the authorized action.
 */
export class DiscordGatewayService {
  private readonly configurationStore: DiscordGatewayConfigurationStore;
  private readonly authorization: DiscordAuthorizationService;
  private readonly socketFactory: (url: string) => GatewaySocket;
  private readonly reconnectDelayMs: number;
  private readonly relayStore: DiscordTurnRelayStore;
  private readonly dispatchingSessions = new Set<string>();
  private unsubscribeEvents: (() => void) | undefined;
  private socket: GatewaySocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private sessionId: string | undefined;
  private resumeGatewayUrl: string | undefined;
  private sequence: number | undefined;
  private token: string | undefined;

  constructor(private readonly options: DiscordGatewayServiceOptions) {
    this.configurationStore = new DiscordGatewayConfigurationStore(
      options.homeDir,
    );
    this.authorization = new DiscordAuthorizationService(
      this.configurationStore,
    );
    this.relayStore = new DiscordTurnRelayStore(options.homeDir);
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
  }

  start(): void {
    if (!this.stopped && this.socket) return;
    this.stopped = false;
    let configuration: DiscordGatewayConfiguration;
    try {
      configuration = this.configurationStore.read();
    } catch (error) {
      if (error instanceof DiscordGatewayConfigurationError) {
        this.options.logger.warn(
          'Discord gateway configuration is unavailable',
        );
        recordGatewayEvent('policy_unavailable');
        return;
      }
      throw error;
    }
    if (configuration.enabled !== true || !configuration.token) {
      recordGatewayEvent('disabled');
      return;
    }
    this.token = configuration.token;
    this.subscribeToOrchestrationEvents();
    this.connect(this.resumeGatewayUrl ?? DISCORD_GATEWAY_URL);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = undefined;
    this.heartbeatTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.token = undefined;
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = undefined;
    if (socket) socket.close();
  }

  private connect(url: string): void {
    // The URL is deliberately constant or server-provided resume state and is
    // never logged: operational logs must not become a second secret store.
    const socket = this.socketFactory(url);
    this.socket = socket;
    socket.on('open', () => recordGatewayEvent('connected'));
    socket.on('message', (raw) => this.handleMessage(raw));
    socket.on('error', () => {
      this.options.logger.warn('Discord gateway connection error');
      recordGatewayEvent('connection_error');
    });
    socket.on('close', () => this.handleClose(socket));
  }

  private handleClose(socket: GatewaySocket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (this.stopped) return;
    recordGatewayEvent('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.stopped)
        this.connect(this.resumeGatewayUrl ?? DISCORD_GATEWAY_URL);
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref?.();
  }

  private handleMessage(raw: unknown): void {
    let envelope: GatewayEnvelope;
    try {
      envelope = JSON.parse(String(raw)) as GatewayEnvelope;
    } catch {
      this.options.logger.warn('Discord gateway sent an invalid message');
      recordGatewayEvent('invalid_message');
      return;
    }
    if (typeof envelope.s === 'number') this.sequence = envelope.s;
    if (envelope.op === 10) {
      this.handleHello(envelope.d);
      return;
    }
    if (envelope.op === 7) {
      this.socket?.close();
      return;
    }
    if (envelope.op === 9) {
      this.sessionId = undefined;
      this.resumeGatewayUrl = undefined;
      this.sequence = undefined;
      this.socket?.close();
      return;
    }
    if (envelope.t === 'READY') this.rememberReady(envelope.d);
    if (envelope.t === 'MESSAGE_CREATE')
      void this.handleInboundMessage(envelope.d);
  }

  private handleHello(payload: unknown): void {
    if (!isObject(payload) || typeof payload.heartbeat_interval !== 'number') {
      this.options.logger.warn('Discord gateway HELLO was invalid');
      recordGatewayEvent('invalid_hello');
      return;
    }
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(
      () => this.send({ op: 1, d: this.sequence ?? null }),
      payload.heartbeat_interval,
    );
    this.heartbeatTimer.unref?.();
    if (this.sessionId && this.sequence !== undefined) {
      this.send({
        op: 6,
        d: {
          token: this.token,
          session_id: this.sessionId,
          seq: this.sequence,
        },
      });
      return;
    }
    this.send({
      op: 2,
      d: {
        token: this.token,
        intents: DISCORD_GUILD_MESSAGES_INTENT,
        properties: {
          os: process.platform,
          browser: 'station',
          device: 'station',
        },
      },
    });
  }

  private send(payload: unknown): void {
    try {
      this.socket?.send(JSON.stringify(payload));
    } catch {
      this.options.logger.warn('Discord gateway send failed');
      recordGatewayEvent('send_error');
    }
  }

  private rememberReady(payload: unknown): void {
    if (!isObject(payload)) return;
    if (typeof payload.session_id === 'string')
      this.sessionId = payload.session_id;
    if (typeof payload.resume_gateway_url === 'string') {
      this.resumeGatewayUrl = gatewayResumeUrl(payload.resume_gateway_url);
    }
  }

  private async handleInboundMessage(payload: unknown): Promise<void> {
    if (!isObject(payload) || !isObject(payload.author)) return;
    if (
      typeof payload.author.id !== 'string' ||
      typeof payload.guild_id !== 'string' ||
      typeof payload.channel_id !== 'string' ||
      typeof payload.id !== 'string' ||
      typeof payload.content !== 'string' ||
      payload.content.trim().length === 0 ||
      payload.author.bot === true
    ) {
      return;
    }
    const result = this.authorization.authorize({
      discordUserId: payload.author.id,
      guildId: payload.guild_id,
      channelId: payload.channel_id,
      capability: 'turn:start',
    });
    recordGatewayEvent(result.allowed ? 'authorized' : result.reason);
    this.options.onAuthorization?.(result);
    if (!result.allowed || !this.options.executeForegroundMessage) return;

    let binding: DiscordChannelSessionBinding | undefined;
    try {
      binding = findDiscordChannelSessionBinding(
        this.configurationStore.read(),
        payload.guild_id,
        payload.channel_id,
      );
    } catch {
      recordGatewayEvent('policy_unavailable');
      return;
    }
    if (!binding) {
      recordGatewayEvent('session_unbound');
      await this.deliverAcknowledgement(
        payload.channel_id,
        'This channel is not bound to a Station session.',
      );
      return;
    }

    // This is intentionally a refusal, not #2805's device-local queue. A
    // Discord turn needs fresh remote identity/capability resolution at its
    // own ingress boundary; carrying it through an offline-device queue would
    // blur that decision and permit unbounded channel backlog.
    if (
      this.dispatchingSessions.has(binding.sessionId) ||
      this.relayStore.hasSession(binding.sessionId)
    ) {
      recordGatewayEvent('turn_busy');
      await this.deliverAcknowledgement(
        payload.channel_id,
        'A Station turn is already running for this channel. Please wait for it to finish.',
      );
      return;
    }

    this.dispatchingSessions.add(binding.sessionId);
    try {
      const dispatched = await this.options.executeForegroundMessage({
        conversationId: binding.sessionId,
        message: payload.content,
        userId: result.stationIdentity,
        clientTurnId: `discord:${payload.id}`,
      });
      if (!dispatched.providerTurnId) {
        recordGatewayEvent('turn_indeterminate');
        await this.deliverAcknowledgement(
          payload.channel_id,
          'Station could not confirm that this turn started. Do not retry automatically.',
        );
        return;
      }
      this.relayStore.add({
        turnId: dispatched.providerTurnId,
        sessionId: binding.sessionId,
        discordUserId: payload.author.id,
        guildId: payload.guild_id,
        channelId: payload.channel_id,
      });
      recordGatewayEvent('turn_started');
    } catch {
      // The real orchestration seam owns detailed receipts. Do not echo a
      // provider error or inbound content into Discord or logs.
      recordGatewayEvent('turn_refused');
      await this.deliverAcknowledgement(
        payload.channel_id,
        'Station could not start this turn.',
      );
    } finally {
      this.dispatchingSessions.delete(binding.sessionId);
    }
  }

  private subscribeToOrchestrationEvents(): void {
    if (this.unsubscribeEvents || !this.options.eventBus) return;
    this.unsubscribeEvents = this.options.eventBus.subscribe((message) => {
      if (message.event !== SERVER_EVENTS.ORCHESTRATION_EVENT) return;
      const event = message.data?.event;
      if (!isCanonicalTurnCompletedEvent(event)) return;
      void this.relayTurnCompletion(event).catch(() => {
        this.options.logger.warn('Discord turn relay failed');
        recordGatewayEvent('relay_error');
      });
    });
  }

  private async relayTurnCompletion(
    event: Extract<CanonicalRuntimeEvent, { method: 'turn.completed' }>,
  ): Promise<void> {
    const relay = this.relayStore.findByTurnId(event.turnId);
    if (!relay) return;

    // Capability is deliberately re-resolved at delivery time. A user who
    // may start a turn but may not read transcripts gets only the completion
    // acknowledgement, never content from this event projection.
    const transcriptAuthorization = this.authorization.authorize({
      discordUserId: relay.discordUserId,
      guildId: relay.guildId,
      channelId: relay.channelId,
      capability: 'transcript:read',
    });
    if (!transcriptAuthorization.allowed) {
      await this.deliverAcknowledgement(
        relay.channelId,
        `Station completed the turn. View it in Station: ${stationSessionPointer(relay.sessionId)}`,
      );
      this.relayStore.remove(event.turnId);
      recordGatewayEvent('relay_acknowledged');
      return;
    }

    const transcript = this.options.readTranscript?.({
      sessionId: relay.sessionId,
      turnId: event.turnId,
    });
    await this.deliverAcknowledgement(
      relay.channelId,
      renderDiscordTranscript(transcript ?? '', relay.sessionId),
    );
    this.relayStore.remove(event.turnId);
    recordGatewayEvent('relay_delivered');
  }

  private async deliverAcknowledgement(
    channelId: string,
    content: string,
  ): Promise<void> {
    let configuration: DiscordGatewayConfiguration;
    try {
      configuration = this.configurationStore.read();
    } catch {
      return;
    }
    if (!configuration.enabled || !configuration.token) return;
    try {
      await (this.options.deliverMessage ?? defaultDeliverMessage)({
        token: configuration.token,
        channelId,
        content,
      });
    } catch {
      this.options.logger.warn('Discord message delivery failed');
      recordGatewayEvent('delivery_error');
    }
  }
}

function isCanonicalTurnCompletedEvent(
  value: unknown,
): value is Extract<CanonicalRuntimeEvent, { method: 'turn.completed' }> {
  return (
    isObject(value) &&
    value.method === 'turn.completed' &&
    typeof value.turnId === 'string'
  );
}

function stationSessionPointer(sessionId: string): string {
  return `/activity?session=${encodeURIComponent(sessionId)}`;
}

const DISCORD_MESSAGE_MAX_CHARS = 2_000;

export function renderDiscordTranscript(
  output: string,
  sessionId: string,
): string {
  if (output.length <= DISCORD_MESSAGE_MAX_CHARS)
    return output || 'Station completed the turn.';
  const disclosure = `\n\n[Truncated — view the full response in Station: ${stationSessionPointer(sessionId)}]`;
  const room = DISCORD_MESSAGE_MAX_CHARS - disclosure.length;
  const candidate = output.slice(0, room);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf('. '),
    candidate.lastIndexOf('! '),
    candidate.lastIndexOf('? '),
    candidate.lastIndexOf('\n'),
  );
  const text =
    sentenceEnd >= Math.floor(room / 2)
      ? candidate.slice(0, sentenceEnd + 1)
      : `${candidate.trimEnd()}…`;
  return `${text}${disclosure}`;
}

async function defaultDeliverMessage(input: {
  token: string;
  channelId: string;
  content: string;
}): Promise<void> {
  const response = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(input.channelId)}/messages`,
    {
      method: 'POST',
      headers: {
        authorization: `Bot ${input.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: input.content }),
    },
  );
  if (!response.ok) throw new Error('Discord message delivery was rejected');
}
