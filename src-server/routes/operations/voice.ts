import { Hono } from 'hono';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import {
  type ExternalSurfaceCapabilityRule,
  requiredExternalSurfaceCapability,
} from '../../security/pairing-route-scopes.js';
import {
  classifyRuntimePeer,
  normalizeSocketAddress,
  RuntimeAuthFailureLimiter,
  type RuntimePeerClass,
} from '../../security/runtime-request-security.js';
import {
  authenticatedWebSocketAck,
  decodeWebSocketAuthFrame,
  hasWebSocketCredentialQuery,
  WEBSOCKET_AUTH_CLOSE,
} from '../../security/websocket-auth.js';
import { voiceOps } from '../../telemetry/metrics.js';
import { VoiceSessionService } from '../../voice/voice-session.js';
import {
  getBody,
  param,
  validate,
  voiceSessionCreateSchema,
} from '../schemas/schemas.js';

export function createVoiceRoutes(voiceService: VoiceSessionService): Hono {
  const app = new Hono();

  app.post('/sessions', validate(voiceSessionCreateSchema), async (c) => {
    const body = getBody(c);
    const agentSlug = body?.agentSlug;
    const sessionId = crypto.randomUUID();
    voiceOps.add(1, { op: 'session.create' });
    return c.json({
      success: true,
      data: { sessionId, agentSlug: agentSlug ?? 'station-voice' },
    });
  });

  app.delete('/sessions/:id', async (c) => {
    await voiceService.destroySession(param(c, 'id'));
    voiceOps.add(1, { op: 'session.destroy' });
    return c.json({ success: true });
  });

  app.get('/status', (c) => {
    voiceOps.add(1, { op: 'status' });
    return c.json({
      success: true,
      data: { activeSessions: voiceService.getActiveCount() },
    });
  });
  app.get('/agent', (c) =>
    c.json({
      success: true,
      data: {
        slug: 'station-voice',
        activeSessions: voiceService.getActiveCount(),
      },
    }),
  );

  return app;
}

// Ports already bound in this process. The voice WS binds once at startup; a
// runtime re-init must NOT re-bind (it throws EADDRINUSE → uncaughtException →
// the whole server shuts down). Idempotent by port.
const boundVoiceWsPorts = new Set<number>();

const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_AUTH_FRAME_BYTES = 4_096;
const DEFAULT_MAX_AUTH_FAILURES = 3;
// Voice audio frames remain comfortably below this ceiling while a single
// unauthenticated socket cannot make `ws` buffer an unbounded message.
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_MAX_UNAUTHENTICATED_CONNECTIONS = 64;
const DEFAULT_MAX_UNAUTHENTICATED_CONNECTIONS_PER_PEER = 8;
const AUTH_CAPACITY_CLOSE = [4429, 'authentication_capacity_exceeded'] as const;

export interface VoiceWebSocketAuthOptions {
  classifyPeer?: (address: string | undefined) => RuntimePeerClass;
  verifyCredential: (credential: string) => boolean | Promise<boolean>;
  authTimeoutMs?: number;
  maxAuthFrameBytes?: number;
  maxAuthFailures?: number;
  maxPayloadBytes?: number;
  maxUnauthenticatedConnections?: number;
  maxUnauthenticatedConnectionsPerPeer?: number;
  now?: () => number;
  audit?: (record: {
    event: 'station.auth.failure' | 'station.auth.rate_limited';
    outcome: 'denied';
    reason: string;
    peerClass: RuntimePeerClass;
    transport: 'websocket';
    timestamp: number;
  }) => void;
  limiter?: Pick<
    RuntimeAuthFailureLimiter,
    'retryAfterSeconds' | 'recordFailure' | 'clear'
  >;
  /** Test seam; production uses the central external-surface table. */
  resolveCapability?: (
    path: string,
  ) => ExternalSurfaceCapabilityRule | undefined;
}

type VoiceFailureLimiter = NonNullable<VoiceWebSocketAuthOptions['limiter']>;

function auditVoiceFailure(
  auth: VoiceWebSocketAuthOptions,
  peerClass: RuntimePeerClass,
  reason: string,
  rateLimited = false,
): void {
  auth.audit?.({
    event: rateLimited ? 'station.auth.rate_limited' : 'station.auth.failure',
    outcome: 'denied',
    reason,
    peerClass,
    transport: 'websocket',
    timestamp: auth.now?.() ?? Date.now(),
  });
}

class UnauthenticatedVoiceConnections {
  readonly #byPeer = new Map<string, number>();
  #total = 0;

  constructor(
    readonly maxTotal: number,
    readonly maxPerPeer: number,
  ) {}

  reserve(peer: string): (() => void) | undefined {
    const peerCount = this.#byPeer.get(peer) ?? 0;
    if (this.#total >= this.maxTotal || peerCount >= this.maxPerPeer) {
      return undefined;
    }
    this.#total += 1;
    this.#byPeer.set(peer, peerCount + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#total -= 1;
      const remaining = (this.#byPeer.get(peer) ?? 1) - 1;
      if (remaining > 0) this.#byPeer.set(peer, remaining);
      else this.#byPeer.delete(peer);
    };
  }
}

function acceptVoiceSession(
  ws: WebSocket,
  url: URL,
  voiceService: VoiceSessionService,
): void {
  const agentSlug = url.searchParams.get('agent') ?? undefined;
  voiceService.createSession(ws, { agentSlug });
}

function authenticateRemoteVoiceSession(
  ws: WebSocket,
  url: URL,
  limiterKey: string,
  voiceService: VoiceSessionService,
  auth: VoiceWebSocketAuthOptions,
  limiter: VoiceFailureLimiter,
  releaseAdmission: () => void,
  peerClass: RuntimePeerClass,
): void {
  let failures = 0;
  let receivedFrames = 0;
  let settled = false;
  const closeBeforeAuthentication = (code: number, reason: string): void => {
    if (settled) return;
    settled = true;
    releaseAdmission();
    ws.close(code, reason);
  };
  const timeout = setTimeout(
    () => {
      auditVoiceFailure(auth, peerClass, 'authentication_timeout');
      limiter.recordFailure(limiterKey);
      closeBeforeAuthentication(...WEBSOCKET_AUTH_CLOSE.timeout);
    },
    Math.max(1, auth.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS),
  );
  const clearAuthTimeout = () => clearTimeout(timeout);
  ws.once('close', () => {
    settled = true;
    clearAuthTimeout();
    releaseAdmission();
  });
  ws.once('error', () => {
    settled = true;
    clearAuthTimeout();
    releaseAdmission();
  });

  const onAuthMessage = async (raw: RawData) => {
    if (settled) return;
    receivedFrames += 1;
    if (receivedFrames > (auth.maxAuthFailures ?? DEFAULT_MAX_AUTH_FAILURES)) {
      auditVoiceFailure(auth, peerClass, 'too_many_authentication_frames');
      limiter.recordFailure(limiterKey);
      closeBeforeAuthentication(...WEBSOCKET_AUTH_CLOSE.required);
      return;
    }
    const decoded = decodeWebSocketAuthFrame(
      raw,
      auth.maxAuthFrameBytes ?? DEFAULT_MAX_AUTH_FRAME_BYTES,
    );
    if (!decoded.ok && decoded.reason === 'frame_too_large') {
      auditVoiceFailure(auth, peerClass, 'authentication_frame_too_large');
      limiter.recordFailure(limiterKey);
      closeBeforeAuthentication(...WEBSOCKET_AUTH_CLOSE.frameTooLarge);
      return;
    }

    if (limiter.retryAfterSeconds(limiterKey) !== undefined) {
      auditVoiceFailure(auth, peerClass, 'too_many_failures', true);
      closeBeforeAuthentication(...WEBSOCKET_AUTH_CLOSE.rateLimited);
      return;
    }

    const valid =
      decoded.ok && (await auth.verifyCredential(decoded.credential));
    if (settled) return;
    if (!valid) {
      auditVoiceFailure(auth, peerClass, 'invalid_credential');
      failures += 1;
      limiter.recordFailure(limiterKey);
      if (failures >= (auth.maxAuthFailures ?? DEFAULT_MAX_AUTH_FAILURES)) {
        closeBeforeAuthentication(...WEBSOCKET_AUTH_CLOSE.required);
      }
      return;
    }

    settled = true;
    clearAuthTimeout();
    ws.off('message', onAuthMessage);
    releaseAdmission();
    limiter.clear(limiterKey);
    ws.send(authenticatedWebSocketAck());
    acceptVoiceSession(ws, url, voiceService);
  };
  ws.on('message', onAuthMessage);
}

export function attachVoiceWebSocket(
  port: number,
  voiceService: VoiceSessionService,
  host?: string,
  auth?: VoiceWebSocketAuthOptions,
): WebSocketServer | null {
  if (boundVoiceWsPorts.has(port)) {
    return null;
  }
  const wss = new WebSocketServer({
    port,
    maxPayload: Math.max(1, auth?.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES),
    ...(host ? { host } : {}),
  });
  const unauthenticatedConnections = new UnauthenticatedVoiceConnections(
    Math.max(
      1,
      auth?.maxUnauthenticatedConnections ??
        DEFAULT_MAX_UNAUTHENTICATED_CONNECTIONS,
    ),
    Math.max(
      1,
      auth?.maxUnauthenticatedConnectionsPerPeer ??
        DEFAULT_MAX_UNAUTHENTICATED_CONNECTIONS_PER_PEER,
    ),
  );
  // Brute-force state is listener-scoped so reconnecting cannot reset the
  // bounded failure window. An injected limiter can share policy with sibling
  // listeners when their peer-key semantics are identical.
  const failureLimiter = auth?.limiter ?? new RuntimeAuthFailureLimiter();
  boundVoiceWsPorts.add(port);
  wss.once('close', () => boundVoiceWsPorts.delete(port));

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const capability = auth?.resolveCapability
      ? auth.resolveCapability(url.pathname)
      : requiredExternalSurfaceCapability('voice-ws', 'CONNECT', url.pathname);
    if (capability?.capability === 'public' && url.search === '') {
      ws.close(1000, 'healthy');
      return;
    }
    const address = req.socket.remoteAddress;
    const limiterKey = normalizeSocketAddress(address) ?? '<absent>';
    const peerClass =
      auth?.classifyPeer?.(address) ?? classifyRuntimePeer(address).peerClass;
    if (capability?.capability !== 'pairing-scope' || url.pathname !== '/') {
      failureLimiter.recordFailure(limiterKey);
      if (auth) auditVoiceFailure(auth, peerClass, 'unexpected_path');
      ws.close(4404, 'unexpected_path');
      return;
    }
    if (hasWebSocketCredentialQuery(url)) {
      failureLimiter.recordFailure(limiterKey);
      if (auth) {
        auditVoiceFailure(auth, peerClass, 'query_credential_rejected');
      }
      ws.close(...WEBSOCKET_AUTH_CLOSE.queryCredential);
      return;
    }

    if (!auth || peerClass === 'loopback') {
      acceptVoiceSession(ws, url, voiceService);
      return;
    }
    const releaseAdmission = unauthenticatedConnections.reserve(limiterKey);
    if (!releaseAdmission) {
      auditVoiceFailure(
        auth,
        peerClass,
        'authentication_capacity_exceeded',
        true,
      );
      ws.close(...AUTH_CAPACITY_CLOSE);
      return;
    }
    authenticateRemoteVoiceSession(
      ws,
      url,
      limiterKey,
      voiceService,
      auth,
      failureLimiter,
      releaseAdmission,
      peerClass,
    );
  });
  return wss;
}
