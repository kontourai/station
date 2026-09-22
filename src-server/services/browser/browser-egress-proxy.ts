/**
 * The host Chromium's only way out: a Station-owned loopback forward proxy
 * that refuses every connection whose RESOLVED destination is a Station
 * listener on this host (#90 amendment "Station-listener deny").
 *
 * Chromium is launched with `--proxy-server=<this proxy>` and
 * `--proxy-bypass-list=<-loopback>` (so loopback traffic is proxied too, not
 * sent direct). HTTPS and every WebSocket (ws: and wss:) arrive as CONNECT
 * tunnels; plain HTTP arrives as absolute-form requests. This covers pages,
 * workers and service workers alike, because the decision is made at the
 * connection, below any page.
 *
 * The proxy resolves the hostname ITSELF, refuses if ANY resolved address is
 * a Station listener (see `station-listeners.ts`), and then connects to the
 * exact address it checked — never re-resolving — so DNS rebinding between
 * check and connect is not possible. A proxy failure fails closed: Chromium
 * has no direct route around it.
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
  isLocalAddress,
  isStationListenerDestination,
  localInterfaceAddresses,
  type StationListeners,
} from './station-listeners.js';

export type EgressRefusal =
  | 'station-listener'
  | 'resolve-failed'
  | 'invalid-target';

export interface EgressDecisionEvent {
  host: string;
  port: number;
  address?: string;
  refusal: EgressRefusal;
}

export type EgressLookup = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string }>>;

export interface BrowserEgressProxyOptions {
  /** Current Station listeners; re-read for every connection. */
  listeners: () => StationListeners;
  /** This host's interface addresses; defaults to the live interface list. */
  interfaceAddresses?: () => readonly string[];
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
  const match = /^(\[[0-9A-Fa-f:.]+\]|[^:/\s]+):(\d{1,5})$/.exec(value);
  if (!match) return undefined;
  const port = Number(match[2]);
  if (port < 1 || port > 65_535) return undefined;
  return { host: match[1] as string, port };
}

function refuseTunnel(
  socket: Duplex,
  status: '403 Forbidden' | '400 Bad Request' | '502 Bad Gateway',
): void {
  socket.end(
    `HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
  );
}

export class BrowserEgressProxy {
  private server: Server | undefined;
  private listeningPort = 0;
  private readonly sockets = new Set<Socket | Duplex>();
  private readonly lookup: EgressLookup;
  private readonly interfaces: () => readonly string[];

  constructor(private readonly options: BrowserEgressProxyOptions) {
    this.lookup = options.lookup ?? defaultLookup;
    this.interfaces = options.interfaceAddresses ?? localInterfaceAddresses;
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
   * Decide a destination: resolve once, refuse if any address is a Station
   * listener (or this proxy itself), otherwise return the address to dial.
   */
  async resolveDestination(
    rawHost: string,
    port: number,
  ): Promise<
    | { ok: true; address: string }
    | { ok: false; refusal: EgressRefusal; address?: string }
  > {
    const host = rawHost.replace(/^\[|\]$/g, '');
    if (host === '' || !Number.isInteger(port) || port < 1 || port > 65_535)
      return { ok: false, refusal: 'invalid-target' };
    let addresses: string[];
    if (isIP(host) !== 0) {
      addresses = [host];
    } else {
      try {
        addresses = (await this.lookup(host)).map((entry) => entry.address);
      } catch {
        return { ok: false, refusal: 'resolve-failed' };
      }
    }
    if (addresses.length === 0) return { ok: false, refusal: 'resolve-failed' };
    const listeners = this.options.listeners();
    const interfaces = this.interfaces();
    for (const address of addresses) {
      const selfPort =
        port === this.listeningPort && isLocalAddress(address, interfaces);
      if (
        selfPort ||
        isStationListenerDestination(address, port, listeners, interfaces)
      ) {
        return { ok: false, refusal: 'station-listener', address };
      }
    }
    return { ok: true, address: addresses[0] as string };
  }

  private track(socket: Socket | Duplex): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
  }

  private refused(
    host: string,
    port: number,
    refusal: EgressRefusal,
    address?: string,
  ) {
    this.options.onRefused?.({
      host,
      port,
      refusal,
      ...(address ? { address } : {}),
    });
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
    const decision = await this.resolveDestination(target.hostname, port);
    if (!decision.ok) {
      this.refused(target.hostname, port, decision.refusal, decision.address);
      res
        .writeHead(decision.refusal === 'resolve-failed' ? 502 : 403, {
          'content-type': 'text/plain',
          connection: 'close',
        })
        .end('Blocked by Station browser egress policy.');
      return;
    }
    const upstream = httpRequest({
      host: decision.address,
      port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: stripHopByHop(req.headers),
      setHost: false,
      timeout: this.options.connectTimeoutMs ?? 30_000,
    });
    upstream.on('response', (response) => {
      res.writeHead(
        response.statusCode ?? 502,
        stripHopByHop(response.headers),
      );
      response.pipe(res);
    });
    upstream.on('timeout', () =>
      upstream.destroy(new Error('upstream timeout')),
    );
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
    const decision = await this.resolveDestination(
      authority.host,
      authority.port,
    );
    if (!decision.ok) {
      this.refused(
        authority.host,
        authority.port,
        decision.refusal,
        decision.address,
      );
      refuseTunnel(
        socket,
        decision.refusal === 'resolve-failed'
          ? '502 Bad Gateway'
          : '403 Forbidden',
      );
      return;
    }
    this.tunnel(
      socket,
      head,
      decision.address,
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
    const decision = await this.resolveDestination(target.hostname, port);
    if (!decision.ok) {
      this.refused(target.hostname, port, decision.refusal, decision.address);
      refuseTunnel(
        socket,
        decision.refusal === 'resolve-failed'
          ? '502 Bad Gateway'
          : '403 Forbidden',
      );
      return;
    }
    const lines = [`${req.method} ${target.pathname}${target.search} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i] as string;
      if (/^proxy-/i.test(name)) continue;
      lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
    }
    this.tunnel(
      socket,
      head,
      decision.address,
      port,
      undefined,
      `${lines.join('\r\n')}\r\n\r\n`,
    );
  }

  private tunnel(
    client: Duplex,
    head: Buffer,
    address: string,
    port: number,
    replyToClient?: string,
    prefaceToUpstream?: string,
  ): void {
    const upstream = connect({ host: address, port });
    this.track(upstream);
    upstream.setTimeout(this.options.connectTimeoutMs ?? 30_000, () => {
      if (upstream.connecting) upstream.destroy();
    });
    let connected = false;
    upstream.once('connect', () => {
      connected = true;
      upstream.setTimeout(0);
      if (replyToClient) client.write(replyToClient);
      if (prefaceToUpstream) upstream.write(prefaceToUpstream);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once('error', () => {
      // Before the tunnel opened the client still expects a status line;
      // after, the bytes belong to the tunnelled protocol and we just end it.
      if (!connected && replyToClient && !client.writableEnded)
        refuseTunnel(client, '502 Bad Gateway');
      else client.destroy();
    });
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
  }
}
