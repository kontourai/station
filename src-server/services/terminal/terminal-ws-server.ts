import { terminalPtyUnavailableReason } from '@kontourai/station-shared/terminal-capability';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { isPtyUnavailableError } from '../../domain/pty-adapter.js';
import type { TerminalEvent } from '../../domain/terminal-types.js';
import {
  type ExternalSurfaceCapabilityRule,
  requiredExternalSurfaceCapability,
} from '../../security/pairing-route-scopes.js';
import {
  classifyRuntimePeer,
  RuntimeAuthFailureLimiter,
  type RuntimePeerClass,
} from '../../security/runtime-request-security.js';
import {
  authenticatedWebSocketAck,
  decodeWebSocketAuthFrame,
  hasWebSocketCredentialQuery,
  WEBSOCKET_AUTH_CLOSE,
} from '../../security/websocket-auth.js';
import { createLogger } from '../../utils/logger.js';
import {
  outwardTransportFailure,
  sanitizedTransportError,
} from '../../utils/outward-error.js';
import type { TerminalService } from './terminal-service.js';

const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_AUTH_FRAME_BYTES = 4_096;
const DEFAULT_MAX_AUTH_FAILURES = 3;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1_024;
const DEFAULT_MAX_UNAUTHENTICATED_CONNECTIONS = 64;
const DEFAULT_MAX_UNAUTHENTICATED_CONNECTIONS_PER_PEER = 8;
const logger = createLogger({ name: 'terminal-websocket' });

export interface TerminalWebSocketAuthOptions {
  classifyPeer?: (address: string | undefined) => RuntimePeerClass;
  verifyCredential: (credential: string) => boolean | Promise<boolean>;
  authTimeoutMs?: number;
  maxAuthFrameBytes?: number;
  maxAuthFailures?: number;
  maxPayloadBytes?: number;
  maxUnauthenticatedConnections?: number;
  maxUnauthenticatedConnectionsPerPeer?: number;
  limiter?: Pick<
    RuntimeAuthFailureLimiter,
    'retryAfterSeconds' | 'recordFailure' | 'clear'
  >;
  audit?: (record: TerminalWebSocketSecurityAuditRecord) => void;
  now?: () => number;
  /** Test seam; production uses the central external-surface table. */
  resolveCapability?: (
    path: string,
  ) => ExternalSurfaceCapabilityRule | undefined;
}

export interface TerminalWebSocketSecurityAuditRecord {
  event: 'station.auth.failure' | 'station.auth.rate_limited';
  outcome: 'denied';
  reason: string;
  peerClass: RuntimePeerClass;
  transport: 'websocket';
  timestamp: number;
}

export class TerminalWebSocketServer {
  private wss: WebSocketServer | null = null;
  private unsubscribe: (() => void) | null = null;
  private clients = new Set<WebSocket>();
  private clientSessions = new Map<WebSocket, Set<string>>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private authLimiter?: Pick<
    RuntimeAuthFailureLimiter,
    'retryAfterSeconds' | 'recordFailure' | 'clear'
  >;
  private stopPromise: Promise<void> | null = null;
  private unauthenticatedConnections = 0;
  private unauthenticatedConnectionsByPeer = new Map<string, number>();

  constructor(
    private terminalService: TerminalService,
    private auth?: TerminalWebSocketAuthOptions,
  ) {
    if (auth)
      this.authLimiter = auth.limiter ?? new RuntimeAuthFailureLimiter();
  }

  start(port: number, host?: string): WebSocketServer {
    this.wss = new WebSocketServer({
      port,
      maxPayload: Math.max(
        DEFAULT_MAX_AUTH_FRAME_BYTES,
        this.auth?.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      ),
      ...(host ? { host } : {}),
    });

    this.wss.on('connection', (ws: WebSocket, req) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const capability = this.auth?.resolveCapability
        ? this.auth.resolveCapability(url.pathname)
        : requiredExternalSurfaceCapability(
            'terminal-ws',
            'CONNECT',
            url.pathname,
          );
      if (capability?.capability === 'public' && url.search === '') {
        ws.close(1000, 'healthy');
        return;
      }
      if (capability?.capability !== 'pairing-scope' || url.pathname !== '/') {
        ws.close(...WEBSOCKET_AUTH_CLOSE.unsupportedPath);
        return;
      }

      const address = req.socket.remoteAddress;
      const peerClass =
        this.auth?.classifyPeer?.(address) ??
        classifyRuntimePeer(address).peerClass;
      if (this.auth && hasWebSocketCredentialQuery(url)) {
        this.authLimiter?.recordFailure(address ?? '<absent>');
        this.auditFailure('query_credential_rejected', peerClass);
        ws.close(...WEBSOCKET_AUTH_CLOSE.queryCredential);
        return;
      }
      if (!this.auth || peerClass === 'loopback') {
        this.acceptBusinessClient(ws);
        return;
      }
      const limiterKey =
        classifyRuntimePeer(address).address ?? address ?? '<absent>';
      const releaseReservation = this.reserveUnauthenticated(limiterKey);
      if (!releaseReservation) {
        this.auditFailure('authentication_capacity_exceeded', peerClass, true);
        ws.close(...WEBSOCKET_AUTH_CLOSE.capacityExceeded);
        return;
      }
      this.authenticateRemoteClient(
        ws,
        url,
        limiterKey,
        peerClass,
        releaseReservation,
      );
    });
    return this.wss;
  }

  private authenticateRemoteClient(
    ws: WebSocket,
    url: URL,
    limiterKey: string,
    peerClass: RuntimePeerClass,
    releaseReservation: () => void,
  ): void {
    const auth = this.auth;
    if (!auth) return;
    const limiter = this.authLimiter;
    if (!limiter) return;
    const timeout = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        releaseReservation();
        this.auditFailure('authentication_timeout', peerClass);
        ws.close(...WEBSOCKET_AUTH_CLOSE.timeout);
      },
      Math.max(1, auth.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS),
    );
    let failures = 0;
    let authFrames = 0;
    let settled = false;
    const finish = () => {
      settled = true;
      clearTimeout(timeout);
      releaseReservation();
    };
    ws.once('close', finish);
    ws.once('error', finish);

    if (hasWebSocketCredentialQuery(url)) {
      limiter.recordFailure(limiterKey);
      this.auditFailure('query_credential_rejected', peerClass);
      ws.close(...WEBSOCKET_AUTH_CLOSE.queryCredential);
      return;
    }

    const onAuthMessage = async (raw: RawData) => {
      if (settled) return;
      authFrames += 1;
      if (authFrames > (auth.maxAuthFailures ?? DEFAULT_MAX_AUTH_FAILURES)) {
        settled = true;
        limiter.recordFailure(limiterKey);
        this.auditFailure('too_many_authentication_frames', peerClass);
        ws.close(...WEBSOCKET_AUTH_CLOSE.required);
        return;
      }
      const frame = decodeWebSocketAuthFrame(
        raw,
        auth.maxAuthFrameBytes ?? DEFAULT_MAX_AUTH_FRAME_BYTES,
      );
      if (!frame.ok && frame.reason === 'frame_too_large') {
        settled = true;
        limiter.recordFailure(limiterKey);
        this.auditFailure('authentication_frame_too_large', peerClass);
        ws.close(...WEBSOCKET_AUTH_CLOSE.frameTooLarge);
        return;
      }

      const retryAfter = limiter.retryAfterSeconds(limiterKey);
      if (retryAfter !== undefined) {
        settled = true;
        this.auditFailure('too_many_failures', peerClass, true);
        ws.close(...WEBSOCKET_AUTH_CLOSE.rateLimited);
        return;
      }
      const valid = frame.ok && (await auth.verifyCredential(frame.credential));
      if (settled || ws.readyState !== WebSocket.OPEN) {
        finish();
        return;
      }
      if (!valid) {
        failures += 1;
        limiter.recordFailure(limiterKey);
        this.auditFailure('invalid_credential', peerClass);
        if (failures >= (auth.maxAuthFailures ?? DEFAULT_MAX_AUTH_FAILURES)) {
          settled = true;
          ws.close(...WEBSOCKET_AUTH_CLOSE.required);
        }
        return;
      }

      settled = true;
      finish();
      ws.off('message', onAuthMessage);
      limiter.clear(limiterKey);
      ws.send(authenticatedWebSocketAck());
      this.acceptBusinessClient(ws);
    };
    ws.on('message', onAuthMessage);
  }

  private acceptBusinessClient(ws: WebSocket): void {
    this.ensureSubscribed();
    this.clients.add(ws);

    ws.on('message', async (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        console.debug('Failed to parse WebSocket message:', e);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      try {
        switch (msg.type) {
          case 'open': {
            const snapshot = await this.terminalService.open({
              ...(msg as unknown as Parameters<
                typeof this.terminalService.open
              >[0]),
              shell: msg.shell as string | undefined,
              shellArgs: msg.shellArgs as string[] | undefined,
            });
            ws.send(JSON.stringify({ type: 'snapshot', ...snapshot }));
            // Track session ownership
            const sid = snapshot.sessionId;
            if (!this.clientSessions.has(ws))
              this.clientSessions.set(ws, new Set());
            this.clientSessions.get(ws)!.add(sid);
            // Cancel idle timer if client reconnected
            const timer = this.idleTimers.get(sid);
            if (timer) {
              clearTimeout(timer);
              this.idleTimers.delete(sid);
            }
            break;
          }
          case 'data':
            await this.terminalService.write(
              msg.sessionId as string,
              msg.data as string,
            );
            break;
          case 'cwd': {
            const cwd = await this.terminalService.getCwd(
              msg.sessionId as string,
            );
            ws.send(
              JSON.stringify({
                type: 'cwd',
                requestId: msg.requestId,
                cwd,
              }),
            );
            break;
          }
          case 'resize':
            await this.terminalService.resize(
              msg.sessionId as string,
              msg.cols as number,
              msg.rows as number,
            );
            break;
          case 'close':
            await this.terminalService.close(msg.sessionId as string);
            break;
          default:
            ws.send(
              JSON.stringify({
                type: 'error',
                message: `Unknown message type: ${msg.type}`,
              }),
            );
        }
      } catch (err) {
        const failure = outwardTransportFailure('terminalWebSocket');
        logger.error('Terminal WebSocket handler failed', {
          correlationId: failure.correlationId,
          error: sanitizedTransportError(err),
        });
        // A degraded terminal must be loud and specific (#1244). The text is
        // the product-owned constant from station-shared — never the thrown
        // error's message — so the outward-sanitization doctrine holds: no
        // provider, filesystem, or loader detail crosses the socket. The
        // dynamic load cause stays in the correlated server log above.
        if (isPtyUnavailableError(err)) {
          ws.send(
            JSON.stringify({
              type: 'error',
              code: 'terminal-unavailable',
              correlationId: failure.correlationId,
              message: terminalPtyUnavailableReason(),
            }),
          );
          return;
        }
        ws.send(
          JSON.stringify({
            type: 'error',
            ...failure,
          }),
        );
      }
    });

    ws.on('close', () => {
      const sessions = this.clientSessions.get(ws);
      this.clientSessions.delete(ws);
      this.clients.delete(ws);
      if (sessions) {
        for (const sid of sessions) {
          // Check if any other client owns this session
          let owned = false;
          for (const [, s] of this.clientSessions) {
            if (s.has(sid)) {
              owned = true;
              break;
            }
          }
          if (!owned) {
            this.idleTimers.set(
              sid,
              setTimeout(() => {
                this.idleTimers.delete(sid);
                this.terminalService.close(sid);
              }, 60_000),
            );
          }
        }
      }
    });
  }

  private ensureSubscribed(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.terminalService.subscribe(
      (event: TerminalEvent) => {
        const msg = JSON.stringify(event);
        for (const client of this.clients) {
          if (client.readyState === client.OPEN) client.send(msg);
        }
      },
    );
  }

  private reserveUnauthenticated(peerKey: string): (() => void) | undefined {
    const globalLimit = Math.max(
      1,
      this.auth?.maxUnauthenticatedConnections ??
        DEFAULT_MAX_UNAUTHENTICATED_CONNECTIONS,
    );
    const peerLimit = Math.max(
      1,
      this.auth?.maxUnauthenticatedConnectionsPerPeer ??
        DEFAULT_MAX_UNAUTHENTICATED_CONNECTIONS_PER_PEER,
    );
    const peerCount = this.unauthenticatedConnectionsByPeer.get(peerKey) ?? 0;
    if (
      this.unauthenticatedConnections >= globalLimit ||
      peerCount >= peerLimit
    ) {
      return undefined;
    }
    this.unauthenticatedConnections += 1;
    this.unauthenticatedConnectionsByPeer.set(peerKey, peerCount + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.unauthenticatedConnections -= 1;
      const remaining =
        (this.unauthenticatedConnectionsByPeer.get(peerKey) ?? 1) - 1;
      if (remaining <= 0) this.unauthenticatedConnectionsByPeer.delete(peerKey);
      else this.unauthenticatedConnectionsByPeer.set(peerKey, remaining);
    };
  }

  private auditFailure(
    reason: string,
    peerClass: RuntimePeerClass,
    rateLimited = false,
  ): void {
    this.auth?.audit?.({
      event: rateLimited ? 'station.auth.rate_limited' : 'station.auth.failure',
      outcome: 'denied',
      reason,
      peerClass,
      transport: 'websocket',
      timestamp: this.auth.now?.() ?? Date.now(),
    });
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;

    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const t of this.idleTimers.values()) clearTimeout(t);
    this.idleTimers.clear();
    const wss = this.wss;
    const sockets = new Set([...this.clients, ...(wss?.clients ?? [])]);
    for (const client of sockets) {
      client.terminate();
    }
    this.clients.clear();
    this.clientSessions.clear();
    if (!wss) return Promise.resolve();

    const closing = new Promise<void>((resolve, reject) => {
      wss.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }).then(() => {
      if (this.wss === wss) this.wss = null;
    });
    this.stopPromise = closing.finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }
}
