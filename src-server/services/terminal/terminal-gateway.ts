import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import { TERMINAL_SOCKET_PATH } from '@kontourai/station-contracts/terminal-transport';
import { WebSocket, WebSocketServer } from 'ws';
import type { ListenerLink } from '../../runtime/bootstrap/supervisor-link.js';
import { RuntimeAuthFailureLimiter } from '../../security/runtime-request-security.js';
import {
  authenticatedWebSocketAck,
  decodeWebSocketAuthFrame,
  WEBSOCKET_AUTH_CLOSE,
} from '../../security/websocket-auth.js';
import { createLogger } from '../../utils/logger.js';
import { TerminalChannelConnection } from './terminal-channel-connection.js';
import type { TerminalSessions } from './terminal-sessions.js';

const logger = createLogger({ name: 'terminal-gateway' });
const gateways = new WeakMap<object, TerminalGateway<Request>>();

/** App-owned registration keeps the gateway on the same API listener. */
export function registerTerminalGateway(
  app: object,
  gateway: TerminalGateway<Request>,
): void {
  gateways.set(app, gateway);
}
export function terminalGatewayFor(
  app: object,
): TerminalGateway<Request> | undefined {
  return gateways.get(app);
}

export class TerminalGateway<Principal> {
  private wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024 + 13,
    perMessageDeflate: false,
  });
  private connections = new Set<TerminalChannelConnection<Principal>>();
  private limiter = new RuntimeAuthFailureLimiter();
  private pendingPeers = new Map<string, number>();
  private pendingSockets = new Set<WebSocket>();
  private unmount?: () => void;

  constructor(
    private options: {
      sessions: TerminalSessions<Principal>;
      allowedOrigins: readonly string[];
      authenticate: (
        credential: string,
        request: IncomingMessage,
      ) => Promise<Principal | undefined>;
    },
  ) {}

  mount(server: Server, link: Pick<ListenerLink, 'upgraded'>): void {
    const upgrade = (
      request: IncomingMessage,
      socket: Socket,
      head: Buffer,
    ) => {
      if (request.url !== TERMINAL_SOCKET_PATH) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }
      if (
        [request.headers.origin, request.headers['sec-websocket-origin']].some(
          (origin) =>
            origin !== undefined &&
            (typeof origin !== 'string' ||
              !this.options.allowedOrigins.includes(origin)),
        )
      ) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      const peer = request.socket.remoteAddress ?? '<absent>';
      if (
        this.connections.size >= 64 ||
        this.pendingSockets.size >= 32 ||
        (this.pendingPeers.get(peer) ?? 0) >= 8 ||
        this.limiter.retryAfterSeconds(peer) !== undefined
      ) {
        socket.end(
          'HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n',
        );
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request);
        link.upgraded(request.socket);
        this.authenticate(ws, request, peer);
      });
    };
    server.on('upgrade', upgrade);
    this.unmount = () => server.off('upgrade', upgrade);
  }

  stop(): void {
    this.unmount?.();
    for (const connection of this.connections) connection.stop();
    this.connections.clear();
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }

  private authenticate(
    ws: WebSocket,
    request: IncomingMessage,
    peer: string,
  ): void {
    this.pendingPeers.set(peer, (this.pendingPeers.get(peer) ?? 0) + 1);
    this.pendingSockets.add(ws);
    let pending = true;
    let checking = false;
    const release = () => {
      if (!pending) return;
      pending = false;
      this.pendingSockets.delete(ws);
      clearTimeout(timeout);
      const count = (this.pendingPeers.get(peer) ?? 1) - 1;
      if (count) this.pendingPeers.set(peer, count);
      else this.pendingPeers.delete(peer);
    };
    const timeout = setTimeout(() => {
      this.limiter.recordFailure(peer);
      release();
      ws.close(...WEBSOCKET_AUTH_CLOSE.timeout);
      const terminate = setTimeout(() => ws.terminate(), 100);
      terminate.unref();
      ws.once('close', () => clearTimeout(terminate));
    }, 5000);
    ws.once('close', release);
    ws.once('error', release);
    ws.on('error', (error) =>
      logger.debug('Terminal socket failed', { error }),
    );
    // One frame, one in-flight verification. Pipelined commands before the
    // authentication acknowledgement are refused rather than being replayed.
    const message = async (raw: import('ws').RawData, binary: boolean) => {
      if (!pending || checking) {
        ws.close(...WEBSOCKET_AUTH_CLOSE.required);
        return;
      }
      checking = true;
      const frame = binary ? undefined : decodeWebSocketAuthFrame(raw, 4096);
      try {
        const principal = frame?.ok
          ? await this.options.authenticate(frame.credential, request)
          : undefined;
        if (!pending || ws.readyState !== WebSocket.OPEN) return;
        if (principal === undefined) {
          this.limiter.recordFailure(peer);
          release();
          ws.close(...WEBSOCKET_AUTH_CLOSE.required);
          return;
        }
        release();
        if (this.connections.size >= 64) {
          ws.close(4429, 'terminal_connection_capacity');
          return;
        }
        this.limiter.clear(peer);
        ws.off('message', message);
        const connection = new TerminalChannelConnection(
          ws,
          this.options.sessions,
          principal,
        );
        this.connections.add(connection);
        ws.once('close', () => this.connections.delete(connection));
        ws.send(authenticatedWebSocketAck());
      } catch (error) {
        logger.warn('Terminal authentication unavailable', { error });
        release();
        ws.close(...WEBSOCKET_AUTH_CLOSE.required);
      }
    };
    ws.on('message', message);
  }
}
