import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import {
  TERMINAL_CLOSE,
  TERMINAL_SOCKET_PATH,
  TERMINAL_SOCKET_PROTOCOL,
  TERMINAL_TICKET_PROTOCOL_PREFIX,
} from '@kontourai/station-contracts/terminal-transport';
import { type WebSocket, WebSocketServer } from 'ws';
import type { ListenerLink } from '../../runtime/bootstrap/supervisor-link.js';
import { authenticatedWebSocketAck } from '../../security/websocket-auth.js';
import { createLogger } from '../../utils/logger.js';
import {
  closeTerminalSocket,
  TerminalChannelConnection,
} from './terminal-channel-connection.js';
import type { TerminalSessions } from './terminal-sessions.js';
import type { TerminalTickets } from './terminal-tickets.js';

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

export interface TerminalGatewayLimits {
  /** Authenticated sockets across every identity. */
  connections: number;
  /** Sockets one identity (a credential or device) may hold. */
  perIdentity: number;
  /** Slots only an identity marked `reserved` (the operator in person) may use. */
  reserved: number;
  /** A socket is closed with {@link TERMINAL_CLOSE.lifetime} after this long. */
  maxLifetimeMs: number;
  /** Protocol ping interval; a peer that misses one pong is terminated. */
  heartbeatMs: number;
}

const DEFAULT_LIMITS: TerminalGatewayLimits = {
  connections: 64,
  perIdentity: 8,
  reserved: 8,
  maxLifetimeMs: 60 * 60 * 1000,
  heartbeatMs: 15_000,
};

/** Reads the offered subprotocols: every ticket, and whether the version is offered. */
function offered(request: IncomingMessage): {
  tickets: string[];
  versioned: boolean;
} {
  const header = request.headers['sec-websocket-protocol'];
  const values =
    typeof header === 'string'
      ? header.split(',').map((value) => value.trim())
      : [];
  return {
    tickets: values
      .filter((value) => value.startsWith(TERMINAL_TICKET_PROTOCOL_PREFIX))
      .map((value) => value.slice(TERMINAL_TICKET_PROTOCOL_PREFIX.length)),
    versioned: values.includes(TERMINAL_SOCKET_PROTOCOL),
  };
}

/**
 * The terminal socket on the main API listener. Admission happens before the
 * upgrade: a request must redeem a single-use ticket that an authenticated
 * HTTP request minted (`TerminalTickets`). An unauthenticated peer therefore
 * never holds a socket, and no admission state is keyed by network address,
 * so a relay, proxy or tailnet address shared by several people cannot be
 * locked out by one of them. Capacity is shared fairly per identity, with
 * slots reserved for the operator in person.
 */
export class TerminalGateway<Principal> {
  private wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024 + 13,
    perMessageDeflate: false,
    // Never echo the ticket: select only the version subprotocol.
    handleProtocols: (protocols) =>
      protocols.has(TERMINAL_SOCKET_PROTOCOL)
        ? TERMINAL_SOCKET_PROTOCOL
        : false,
  });
  private connections = new Map<
    TerminalChannelConnection<Principal>,
    { identity: string; reserved: boolean }
  >();
  /** Whether each socket answered the previous ping. */
  private alive = new Map<WebSocket, boolean>();
  private readonly limits: TerminalGatewayLimits;
  private heartbeat?: ReturnType<typeof setInterval>;
  private unmount?: () => void;

  constructor(
    private options: {
      sessions: TerminalSessions<Principal>;
      tickets: TerminalTickets<Principal>;
      /** True for an identity that may use the reserved operator slots. */
      reserved: (principal: Principal) => boolean;
      limits?: Partial<TerminalGatewayLimits>;
    },
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

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
      const { tickets, versioned } = offered(request);
      // Every presented ticket is consumed, whatever happens next: a ticket
      // seen once is never admitted later.
      const redeemed = tickets.map((ticket) =>
        this.options.tickets.redeem(ticket),
      );
      const admitted =
        versioned && redeemed.length === 1 ? redeemed[0] : undefined;
      if (!admitted) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
      }
      const reserved = this.options.reserved(admitted.principal);
      if (!this.hasCapacity(admitted.identity, reserved)) {
        socket.end(
          'HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n',
        );
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        link.upgraded(request.socket);
        this.accept(ws, admitted.principal, admitted.identity, reserved);
      });
    };
    server.on('upgrade', upgrade);
    this.heartbeat = setInterval(() => this.ping(), this.limits.heartbeatMs);
    this.heartbeat.unref?.();
    this.unmount = () => server.off('upgrade', upgrade);
  }

  stop(): void {
    this.unmount?.();
    clearInterval(this.heartbeat);
    for (const connection of this.connections.keys()) connection.stop();
    this.connections.clear();
    for (const ws of this.alive.keys()) ws.terminate();
    this.alive.clear();
    this.wss.close();
  }

  private hasCapacity(identity: string, reserved: boolean): boolean {
    let total = 0;
    let unreserved = 0;
    let held = 0;
    for (const connection of this.connections.values()) {
      ++total;
      if (!connection.reserved) ++unreserved;
      if (connection.identity === identity) ++held;
    }
    return (
      total < this.limits.connections &&
      held < this.limits.perIdentity &&
      (reserved || unreserved < this.limits.connections - this.limits.reserved)
    );
  }

  private accept(
    ws: WebSocket,
    principal: Principal,
    identity: string,
    reserved: boolean,
  ): void {
    // Capacity was checked before the upgrade; a concurrent upgrade may have
    // taken the last slot while this handshake completed.
    if (!this.hasCapacity(identity, reserved)) {
      closeTerminalSocket(ws, TERMINAL_CLOSE.capacity, 'terminal_capacity');
      return;
    }
    this.alive.set(ws, true);
    ws.on('pong', () => {
      if (this.alive.has(ws)) this.alive.set(ws, true);
    });
    ws.on('error', (error) =>
      logger.debug('Terminal socket failed', { error }),
    );
    const connection = new TerminalChannelConnection(
      ws,
      this.options.sessions,
      principal,
    );
    this.connections.set(connection, { identity, reserved });
    const lifetime = setTimeout(
      () =>
        closeTerminalSocket(
          ws,
          TERMINAL_CLOSE.lifetime,
          'terminal_connection_lifetime',
        ),
      this.limits.maxLifetimeMs,
    );
    lifetime.unref?.();
    ws.once('close', () => {
      clearTimeout(lifetime);
      this.connections.delete(connection);
      this.alive.delete(ws);
    });
    ws.send(authenticatedWebSocketAck());
  }

  /** A half-open peer never answers; it is terminated, freeing its slot. */
  private ping(): void {
    for (const [ws, alive] of this.alive) {
      if (!alive) {
        ws.terminate();
        continue;
      }
      this.alive.set(ws, false);
      try {
        ws.ping();
      } catch (error) {
        logger.debug('Terminal ping failed', { error });
        ws.terminate();
      }
    }
  }
}
