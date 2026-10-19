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
import {
  closeStableListener,
  type ListenAddress,
  listenerLink,
  type SupervisorListenerName,
} from './supervisor-link.js';

/**
 * Closing it stops the listener at once, as `ws` does for a port it owns.
 * With an external server `ws` would leave the port bound until every client
 * had gone, since it emits 'close' only then.
 */
class StableWebSocketServer extends WebSocketServer {
  private readonly listener: Server;

  constructor(options: ServerOptions & { server: Server }) {
    super(options);
    this.listener = options.server;
  }

  override close(callback?: (error?: Error) => void): void {
    void closeStableListener(this.listener);
    super.close(callback);
  }
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
  void link.listen(name, server, address).catch(() => {});
  return wss;
}
