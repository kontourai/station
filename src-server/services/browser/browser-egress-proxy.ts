/**
 * The host Chromium's only way out: a Station-owned loopback forward proxy
 * that enforces the profile's egress policy (`egress-policy.ts`) on the
 * RESOLVED and the CONNECTED address (#90 D2/D7, "Station-listener deny").
 *
 * Chromium is launched with `--proxy-server=<this proxy>` and
 * `--proxy-bypass-list=<-loopback>` (so loopback traffic is proxied too, not
 * sent direct). HTTPS and every WebSocket (ws: and wss:) arrive as CONNECT
 * tunnels; plain HTTP arrives as absolute-form requests. This covers pages,
 * workers and service workers alike, because the decision is made at the
 * connection, below any page.
 *
 * 1. The proxy resolves the hostname ITSELF and refuses when ANY resolved
 *    address is refused.
 * 2. It dials the exact address it checked — never re-resolving — so DNS
 *    rebinding between check and connect cannot move the destination.
 * 3. After the TCP connect it checks the socket's actual `remoteAddress`
 *    again, before a single byte is written, and destroys the connection if
 *    that is refused. Any gap between the parser and the kernel's idea of the
 *    address therefore fails closed (review H1).
 *
 * A proxy failure fails closed: Chromium has no direct route around it.
 *
 * Accepted gap (review S2): the proxy listens on 127.0.0.1 without a
 * per-launch secret. Chromium cannot present proxy credentials without a
 * CDP auth handler on every request (WebSockets included, which CDP cannot
 * see), and cannot use a unix-socket proxy; attributing each accepted socket
 * to Chromium's process tree costs a process-table lookup per connection.
 * What another local process gains by using it: at most the reach of the
 * profile's policy, which is never more than a same-host process already
 * has (loopback is not user-isolated) and, for a Project admin profile, much
 * less. Station listeners stay refused either way.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  decideEgress,
  type EgressPolicy,
  type EgressRefusal,
} from './egress-policy.js';

export type { EgressRefusal } from './egress-policy.js';

export interface EgressDecisionEvent {
  host: string;
  port: number;
  address?: string;
  refusal: EgressRefusal;
  /** `resolved` before dialing, `connected` on the socket's actual peer. */
  stage: 'resolved' | 'connected';
}

export type EgressLookup = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string }>>;

export interface BrowserEgressProxyOptions {
  policy: EgressPolicy;
  /** Hostname resolution; defaults to the OS resolver. */
  lookup?: EgressLookup;
  onRefused?: (event: EgressDecisionEvent) => void;
  connectTimeoutMs?: number;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'upgrade',
]);

const defaultLookup: EgressLookup = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

function stripHopByHop(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  const connectionTokens = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || connectionTokens.has(lower)) continue;
    out[lower] = value;
  }
  return out;
}

function parseAuthority(
  value: string,
): { host: string; port: number } | undefined {
  const match = /^(\[[0-9A-Fa-f:.]+\]|[^:/\s[\]]+):(\d{1,5})$/.exec(value);
  if (!match) return undefined;
  const port = Number(match[2]);
  if (port < 1 || port > 65_535) return undefined;
  return { host: match[1] as string, port };
}

type TunnelStatus = '403 Forbidden' | '400 Bad Request' | '502 Bad Gateway';

function refuseTunnel(socket: Duplex, status: TunnelStatus): void {
  socket.end(
    `HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
  );
}

function refusalStatus(refusal: EgressRefusal): TunnelStatus {
  return refusal === 'resolve-failed' ? '502 Bad Gateway' : '403 Forbidden';
}

class ConnectRefused extends Error {
  constructor(
    readonly refusal: EgressRefusal,
    readonly address?: string,
  ) {
    super(`egress refused: ${refusal}`);
  }
}

export class BrowserEgressProxy {
  private server: Server | undefined;
  private listeningPort = 0;
  private readonly sockets = new Set<Socket | Duplex>();
  private readonly lookup: EgressLookup;

  constructor(private readonly options: BrowserEgressProxyOptions) {
    this.lookup = options.lookup ?? defaultLookup;
  }

  get port(): number {
    return this.listeningPort;
  }

  /** The `--proxy-server` value for Chromium. */
  get proxyServerArg(): string {
    return `http://127.0.0.1:${this.listeningPort}`;
  }

  async start(): Promise<number> {
    if (this.server) return this.listeningPort;
    const server = createServer((req, res) => {
      void this.onRequest(req, res);
    });
    server.on('connect', (req, socket, head) => {
      void this.onConnect(req, socket, head);
    });
    server.on('upgrade', (req, socket, head) => {
      void this.onUpgrade(req, socket, head);
    });
    server.on('connection', (socket) => this.track(socket));
    server.on('clientError', (_error, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.listeningPort = (server.address() as { port: number }).port;
    return this.listeningPort;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * The policy decision for one address, including this proxy's own port.
   * `requestedHost` is what the browser asked for (see the rebinding rule).
   */
  decide(
    address: string,
    port: number,
    requestedHost?: string,
  ): EgressRefusal | undefined {
    return decideEgress(
      address,
      port,
      this.options.policy,
      this.listeningPort,
      requestedHost,
    );
  }

  /**
   * Resolve once, refuse if ANY address is refused, otherwise return the
   * address to dial.
   */
  async resolveDestination(
    rawHost: string,
    port: number,
  ): Promise<
    | { ok: true; address: string; requestedHost: string }
    | { ok: false; refusal: EgressRefusal; address?: string }
  > {
    const host = rawHost.replace(/^\[|\]$/g, '');
    if (host === '' || !Number.isInteger(port) || port < 1 || port > 65_535)
      return { ok: false, refusal: 'invalid-target' };
    let addresses: string[];
    const bareName = host.toLowerCase().replace(/\.$/, '');
    if (isIP(host) !== 0) {
      addresses = [host];
    } else if (bareName === 'localhost' || bareName.endsWith('.localhost')) {
      // RFC 6761: `localhost` and `*.localhost` are loopback, decided here as
      // Chromium does, never by a resolver (some Linux resolvers forward
      // `*.localhost` to upstream DNS, which a page's owner may control).
      addresses = ['127.0.0.1', '::1'];
    } else {
      try {
        addresses = (await this.lookup(host)).map((entry) => entry.address);
      } catch {
        return { ok: false, refusal: 'resolve-failed' };
      }
    }
    if (addresses.length === 0) return { ok: false, refusal: 'resolve-failed' };
    for (const address of addresses) {
      const refusal = this.decide(address, port, host);
      if (refusal) return { ok: false, refusal, address };
    }
    return { ok: true, address: addresses[0] as string, requestedHost: host };
  }

  /**
   * Dial the checked address and re-check the socket's actual peer before
   * anything is written. Rejects with {@link ConnectRefused} on refusal.
   */
  private connectChecked(
    address: string,
    port: number,
    requestedHost: string,
  ): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: address, port });
      this.track(socket);
      socket.setTimeout(this.options.connectTimeoutMs ?? 30_000, () => {
        if (socket.connecting) socket.destroy(new Error('connect timeout'));
      });
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        socket.setTimeout(0);
        const peer = socket.remoteAddress;
        const refusal =
          peer === undefined
            ? 'invalid-target'
            : this.decide(peer, port, requestedHost);
        if (refusal) {
          socket.destroy();
          reject(new ConnectRefused(refusal, peer));
          return;
        }
        resolve(socket);
      });
    });
  }

  private track(socket: Socket | Duplex): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
  }

  private refused(event: EgressDecisionEvent) {
    this.options.onRefused?.(event);
  }

  private async onRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400, { connection: 'close' }).end();
      return;
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400, { connection: 'close' }).end();
      return;
    }
    const port = target.port === '' ? 80 : Number(target.port);
    const blocked = (refusal: EgressRefusal) =>
      res
        .writeHead(refusal === 'resolve-failed' ? 502 : 403, {
          'content-type': 'text/plain',
          connection: 'close',
        })
        .end('Blocked by Station browser egress policy.');
    const decision = await this.resolveDestination(target.hostname, port);
    if (!decision.ok) {
      this.refused({
        host: target.hostname,
        port,
        refusal: decision.refusal,
        stage: 'resolved',
        ...(decision.address ? { address: decision.address } : {}),
      });
      blocked(decision.refusal);
      return;
    }
    let socket: Socket;
    try {
      socket = await this.connectChecked(
        decision.address,
        port,
        decision.requestedHost,
      );
    } catch (error) {
      if (error instanceof ConnectRefused) {
        this.refused({
          host: target.hostname,
          port,
          refusal: error.refusal,
          stage: 'connected',
          ...(error.address ? { address: error.address } : {}),
        });
        blocked(error.refusal);
      } else if (!res.headersSent) {
        res.writeHead(502, { connection: 'close' }).end();
      }
      return;
    }
    const upstream = httpRequest({
      createConnection: () => socket,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: stripHopByHop(req.headers),
      setHost: false,
      // No `agent`: createConnection is only honoured without one, and the
      // pre-checked socket must be the one used.
    });
    upstream.on('response', (response) => {
      res.writeHead(
        response.statusCode ?? 502,
        stripHopByHop(response.headers),
      );
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { connection: 'close' });
      res.end();
    });
    req.pipe(upstream);
  }

  private async onConnect(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    this.track(socket);
    const authority = parseAuthority(req.url ?? '');
    if (!authority) {
      refuseTunnel(socket, '400 Bad Request');
      return;
    }
    await this.openTunnel(
      socket,
      head,
      authority.host,
      authority.port,
      'HTTP/1.1 200 Connection Established\r\n\r\n',
    );
  }

  /** Plain `ws:` sent to a proxy as an absolute-form upgrade (Chromium tunnels instead). */
  private async onUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    this.track(socket);
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      refuseTunnel(socket, '400 Bad Request');
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'ws:') {
      refuseTunnel(socket, '400 Bad Request');
      return;
    }
    const port = target.port === '' ? 80 : Number(target.port);
    const lines = [`${req.method} ${target.pathname}${target.search} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i] as string;
      if (/^proxy-/i.test(name)) continue;
      lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
    }
    await this.openTunnel(
      socket,
      head,
      target.hostname,
      port,
      undefined,
      `${lines.join('\r\n')}\r\n\r\n`,
    );
  }

  private async openTunnel(
    client: Duplex,
    head: Buffer,
    host: string,
    port: number,
    replyToClient?: string,
    prefaceToUpstream?: string,
  ): Promise<void> {
    const decision = await this.resolveDestination(host, port);
    if (!decision.ok) {
      this.refused({
        host,
        port,
        refusal: decision.refusal,
        stage: 'resolved',
        ...(decision.address ? { address: decision.address } : {}),
      });
      refuseTunnel(client, refusalStatus(decision.refusal));
      return;
    }
    let upstream: Socket;
    try {
      upstream = await this.connectChecked(
        decision.address,
        port,
        decision.requestedHost,
      );
    } catch (error) {
      if (error instanceof ConnectRefused) {
        this.refused({
          host,
          port,
          refusal: error.refusal,
          stage: 'connected',
          ...(error.address ? { address: error.address } : {}),
        });
        refuseTunnel(client, refusalStatus(error.refusal));
      } else if (!client.writableEnded) {
        refuseTunnel(client, '502 Bad Gateway');
      }
      return;
    }
    if (client.destroyed) {
      upstream.destroy();
      return;
    }
    if (replyToClient) client.write(replyToClient);
    if (prefaceToUpstream) upstream.write(prefaceToUpstream);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
  }
}
