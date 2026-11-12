/**
 * A dedicated WebSocket listener bound through the listener link.
 *
 * `new WebSocketServer({ port })` creates and binds its own HTTP server, which
 * cannot listen on a handle the supervisor holds. This creates that server
 * here instead, answering non-upgrade requests exactly as `ws` does for a
 * port it owns, so clients see no difference.
 */
import { createServer, type Server, STATUS_CODES } from 'node:http';
import type { Socket } from 'node:net';
import { type ServerOptions, WebSocketServer } from 'ws';
import { errorMessage } from '../../utils/error-message.js';
import { createLogger } from '../../utils/logger.js';
import {
  closeStableListener,
  type ListenAddress,
  listenerLink,
  type SupervisorListenerName,
} from './supervisor-link.js';

const logger = createLogger({ name: 'websocket-listener' });

/**
 * Closing it stops the listener at once, as `ws` does for a port it owns.
 * With an external server `ws` would leave the port bound until every client
 * had gone, since it emits 'close' only then.
 */
class StableWebSocketServer extends WebSocketServer {
  private readonly listener: Server;
  private listenerClose?: Promise<void>;
  private binding: Promise<void> = Promise.resolve();

  constructor(options: ServerOptions & { server: Server }) {
    super(options);
    this.listener = options.server;
  }

  override close(callback?: (error?: Error) => void): void {
    this.listenerClose ??= this.listener.listening
      ? closeStableListener(this.listener)
      : this.binding.then(() => closeStableListener(this.listener));
    super.close(callback);
  }

  trackBinding(binding: Promise<unknown>): void {
    this.binding = binding.then(
      () => undefined,
      () => undefined,
    );
  }

  whenListenerClosed(): Promise<void> {
    return this.listenerClose ?? Promise.resolve();
  }
}

/** Stop only this listener, terminate its clients and join both close owners. */
export async function closeOwnedWebSocketListener(
  wss: WebSocketServer,
): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    wss.close((error) => (error ? reject(error) : resolve()));
  });
  const errors: unknown[] = [];
  for (const client of wss.clients) {
    try {
      client.terminate();
    } catch (error) {
      errors.push(error);
    }
  }
  const results = await Promise.allSettled([
    closed,
    wss instanceof StableWebSocketServer
      ? wss.whenListenerClosed()
      : Promise.resolve(),
  ]);
  for (const result of results)
    if (result.status === 'rejected') errors.push(result.reason);
  if (errors.length)
    throw new AggregateError(errors, 'WebSocket listener cleanup failed');
}

export function startWebSocketListener(
  name: SupervisorListenerName,
  address: ListenAddress,
  options: Omit<ServerOptions, 'port' | 'host' | 'server' | 'noServer'>,
): WebSocketServer {
  // The same response `ws` sends from the HTTP server it creates for `port`.
  const server = createServer((_req, res) => {
    const body = STATUS_CODES[426] as string;
    res.writeHead(426, {
      'Content-Length': body.length,
      'Content-Type': 'text/plain',
    });
    res.end(body);
  });
  const wss = new StableWebSocketServer({ ...options, server });
  const link = listenerLink();
  // A socket ws upgraded is this WebSocket server's to end, so a drain stops
  // waiting for it. Reported from ws's own 'connection' event, not a second
  // 'upgrade' listener on the server: one that outlived ws's (removed on
  // close) would leave later Upgrade requests unanswered.
  wss.on('connection', (_ws, req) => link.upgraded(req.socket as Socket));
  // A bind failure reaches the WebSocket server's 'error' event, which `ws`
  // forwards from the HTTP server exactly as it does for a port it owns.
  const binding = link.listen(name, server, address);
  wss.trackBinding(binding);
  void binding.catch((error: unknown) => {
    // Covers refusals that never reach the server's 'error' event, such as
    // a listen requested after this generation began draining.
    logger.error('WebSocket listener failed to bind', {
      listener: name,
      port: address.port,
      error: errorMessage(error),
    });
  });
  return wss;
}
