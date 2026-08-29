/**
 * This Station's public tailnet origin, asked of Tailscale rather than
 * reconstructed from a request (archive#3379 follow-up).
 *
 * A pairing endpoint must be an address the DEVICE can reach. The public
 * pairing routes derived it from `new URL(c.req.url).origin`, which is only
 * true when the client reached the API directly. Behind `tailscale serve` —
 * the topology Station's own docs and `station environment offer --tailscale`
 * assume — TLS terminates in the Tailscale daemon and the API sees plain HTTP
 * with either the tailnet Host or, through Station's UI proxy, `127.0.0.1`.
 * Both produce a wrong endpoint, and the first is additionally REJECTED by
 * `createOffer`'s "https or private/loopback" rule, which is why an access
 * request over the tailnet failed with `invalid_request`.
 *
 * Forwarded headers are not the answer: `x-forwarded-proto` and
 * `x-forwarded-host` are attacker-controlled for anyone who can reach the API
 * directly, and this value decides where a credential is later presented. So
 * ask the daemon instead. `tailscale serve status --json` states which public
 * origin proxies to which local port, and `tailscale status --json` states
 * this node's MagicDNS name; neither is client-influenced.
 *
 * Both shipping topologies consume this. Behind Station's own UI proxy the
 * hop is attested and the caller prefers this value outright. Pointed
 * STRAIGHT at a server (a channel app, which has no proxy: archive#3645) no
 * attestation can exist, so the caller instead requires the request's Host
 * to equal the origin resolved here — the daemon's own statement of where it
 * serves us — before using it. `station environment offer --tailscale` still
 * demands the direct topology and refuses the proxy one; that residual
 * disagreement lives with archive#3645's history.
 *
 * This resolves every valid origin. WHETHER to select one over the request
 * URL is the caller's decision, made against the caller's own evidence of how
 * the request arrived.
 */

import { execFile } from 'node:child_process';

export interface TailscaleCliResult {
  readonly stdout: string;
  /** `null` when the CLI could not be executed at all. */
  readonly exitCode: number | null;
}

export type TailscaleCli = (
  args: readonly string[],
) => Promise<TailscaleCliResult>;

/**
 * Tailscale's signed macOS app-bundle command. This is a reviewed, constant
 * path — never a value derived from a request, configuration, or PATH entry.
 */
export const TAILSCALE_MACOS_APP_CLI =
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/**
 * Ordered executable names this process is permitted to invoke. A GUI-launched
 * packaged app does not inherit an interactive shell PATH, so macOS tries the
 * official app bundle before the ordinary PATH installation.
 */
export function tailscaleCliExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  return platform === 'darwin'
    ? [TAILSCALE_MACOS_APP_CLI, 'tailscale']
    : ['tailscale'];
}

export type TailscaleCliExecutor = (
  executable: string,
  args: readonly string[],
) => Promise<TailscaleCliResult>;

/** Loopback hosts a serve mapping may name for a port on this machine. */
const LOOPBACK_PROXY_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  '[::1]',
  '::1',
]);

/**
 * A MagicDNS name, lowercased and trailing-dot-stripped. Deliberately strict:
 * this becomes the authority a paired device is told to trust, so anything
 * that is not a plain `*.ts.net` hostname is refused rather than coerced.
 */
export function parseMagicDnsHost(statusJson: string): string | undefined {
  let status: unknown;
  try {
    status = JSON.parse(statusJson);
  } catch {
    return undefined;
  }
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    return undefined;
  }
  const self = (status as { Self?: unknown }).Self;
  if (!self || typeof self !== 'object' || Array.isArray(self))
    return undefined;
  const record = self as { DNSName?: unknown; Online?: unknown };
  if (record.Online === false) return undefined;
  if (typeof record.DNSName !== 'string') return undefined;
  const host = record.DNSName.replace(/\.$/, '').toLowerCase();
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
      host,
    ) ||
    !host.endsWith('.ts.net')
  ) {
    return undefined;
  }
  return host;
}

/** The local port a serve handler proxies to, when it proxies to this machine. */
function loopbackProxyPort(handler: unknown): number | undefined {
  if (!handler || typeof handler !== 'object' || Array.isArray(handler)) {
    return undefined;
  }
  const proxy = (handler as { Proxy?: unknown }).Proxy;
  if (typeof proxy !== 'string') return undefined;
  let target: URL;
  try {
    target = new URL(proxy);
  } catch {
    return undefined;
  }
  if (target.protocol !== 'http:') return undefined;
  if (!LOOPBACK_PROXY_HOSTS.has(target.hostname)) return undefined;
  if (target.pathname !== '/' && target.pathname !== '') return undefined;
  if (target.search || target.hash) return undefined;
  const port = Number(target.port);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
}

/**
 * The daemon-validated public HTTPS origins that serve one of `localPorts`,
 * ordered deterministically, or `undefined`.
 *
 * Only root (`/`) handlers count: a mapping that serves this Station under a
 * subpath does not make its origin a valid pairing endpoint, because the
 * device would resolve the pairing paths against the origin and miss the
 * prefix. Only mappings on the node's own MagicDNS authority count, so a
 * mapping published for some other host cannot supply the endpoint.
 */
export function parseServePublicOrigins(
  serveJson: string,
  magicDnsHost: string,
  localPorts: readonly number[],
): readonly string[] | undefined {
  let serve: unknown;
  try {
    serve = JSON.parse(serveJson);
  } catch {
    return undefined;
  }
  if (!serve || typeof serve !== 'object' || Array.isArray(serve)) {
    return undefined;
  }
  const web = (serve as { Web?: unknown }).Web;
  if (!web || typeof web !== 'object' || Array.isArray(web)) return undefined;
  const wanted = new Set(localPorts);
  const candidates: string[] = [];
  for (const [authority, listener] of Object.entries(
    web as Record<string, unknown>,
  )) {
    // Keys are `host:port`; IPv6 literals never appear here because a serve
    // listener is published on the node's own MagicDNS authority.
    const separator = authority.lastIndexOf(':');
    if (separator <= 0) continue;
    const host = authority.slice(0, separator).toLowerCase();
    const servePort = Number(authority.slice(separator + 1));
    if (host !== magicDnsHost) continue;
    if (!Number.isInteger(servePort) || servePort <= 0 || servePort > 65_535) {
      continue;
    }
    if (!listener || typeof listener !== 'object' || Array.isArray(listener)) {
      continue;
    }
    const handlers = (listener as { Handlers?: unknown }).Handlers;
    if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) {
      continue;
    }
    const root = (handlers as Record<string, unknown>)['/'];
    const port = loopbackProxyPort(root);
    if (port === undefined || !wanted.has(port)) continue;
    candidates.push(
      servePort === 443 ? `https://${host}` : `https://${host}:${servePort}`,
    );
  }
  if (candidates.length === 0) return undefined;
  // Deterministic when several listeners reach the same Station: prefer the
  // default HTTPS port, then the lowest, so the endpoint a device is handed
  // does not depend on object key order.
  candidates.sort((left, right) => {
    const leftPort = Number(new URL(left).port || '443');
    const rightPort = Number(new URL(right).port || '443');
    if (leftPort === rightPort) return left.localeCompare(right);
    if (leftPort === 443) return -1;
    if (rightPort === 443) return 1;
    return leftPort - rightPort;
  });
  return candidates;
}

/**
 * The deterministic default from {@link parseServePublicOrigins}.
 *
 * Keep this narrow compatibility helper for callers that only need one
 * endpoint. New routing decisions must use all origins: a direct Serve hop
 * can prove exactly which listener accepted its request.
 */
export function parseServePublicOrigin(
  serveJson: string,
  magicDnsHost: string,
  localPorts: readonly number[],
): string | undefined {
  return parseServePublicOrigins(serveJson, magicDnsHost, localPorts)?.[0];
}

export interface PublicIngressOriginResolver {
  /**
   * Daemon-validated origins in canonical order, or `undefined` whenever no
   * origin can be established. Never throws.
   *
   * A proxy-attested request cannot retain its original authority, so its
   * caller uses the first (default HTTPS port, then lowest port) origin. A
   * direct request instead matches its exact request authority against this
   * complete list.
   */
  resolve(): Promise<readonly string[] | undefined>;
}

/**
 * Caches the resolved origins for `ttlMs`. Pairing is rare, but the lookup
 * spawns two processes, and an operator can change `tailscale serve` while
 * Station runs — so this re-reads periodically instead of pinning a value at
 * boot that would silently go stale.
 *
 * A failed lookup is cached for the same interval: when Tailscale is absent
 * (the common case for a laptop-only Station) this must not spawn processes
 * per request.
 */
export function createPublicIngressOriginResolver(input: {
  readonly localPorts: readonly number[];
  readonly cli: TailscaleCli;
  readonly ttlMs?: number;
  readonly now?: () => number;
}): PublicIngressOriginResolver {
  const ttlMs = input.ttlMs ?? 30_000;
  const now = input.now ?? Date.now;
  let cachedAt = Number.NEGATIVE_INFINITY;
  let cached: readonly string[] | undefined;
  let inFlight: Promise<readonly string[] | undefined> | undefined;

  const lookup = async (): Promise<readonly string[] | undefined> => {
    try {
      const status = await input.cli(['status', '--json']);
      if (status.exitCode !== 0) return undefined;
      const host = parseMagicDnsHost(status.stdout);
      if (!host) return undefined;
      const serve = await input.cli(['serve', 'status', '--json']);
      if (serve.exitCode !== 0) return undefined;
      return parseServePublicOrigins(serve.stdout, host, input.localPorts);
    } catch {
      return undefined;
    }
  };

  return {
    async resolve() {
      if (now() - cachedAt < ttlMs) return cached;
      // Collapse concurrent misses so a burst of requests spawns one lookup.
      inFlight ??= lookup().finally(() => {
        inFlight = undefined;
      });
      const resolved = await inFlight;
      cached = resolved;
      cachedAt = now();
      return resolved;
    },
  };
}

/** Bounded, non-throwing invocation of one reviewed Tailscale executable. */
const executeTailscaleCli: TailscaleCliExecutor = (executable, args) =>
  new Promise((resolvePromise) => {
    execFile(
      executable,
      [...args],
      {
        timeout: 2_500,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout) => {
        // An absent CLI, a timeout, and a non-zero exit all mean the same
        // thing to the caller: no origin. `code` is absent for a spawn
        // failure, which `null` distinguishes from a real non-zero exit.
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code satisfies number)
            : error
              ? null
              : 0;
        resolvePromise({ stdout: stdout ?? '', exitCode: code });
      },
    );
  });

/**
 * Bounded, non-throwing CLI discovery. Every executable is an exact reviewed
 * candidate, and only a successful invocation is accepted. This preserves the
 * ordinary PATH install as a fallback when a packaged macOS app cannot invoke
 * its official app-bundle command.
 */
export function createTailscaleCli(
  input: {
    readonly platform?: NodeJS.Platform;
    readonly execute?: TailscaleCliExecutor;
  } = {},
): TailscaleCli {
  const candidates = tailscaleCliExecutableCandidates(input.platform);
  const execute = input.execute ?? executeTailscaleCli;
  return async (args) => {
    for (const executable of candidates) {
      try {
        const result = await execute(executable, args);
        if (result.exitCode === 0) return result;
      } catch {
        // A malformed executor or failed spawn is indistinguishable from an
        // unavailable candidate at this narrow, fail-closed boundary.
      }
    }
    return { stdout: '', exitCode: null };
  };
}

/** Bounded, non-throwing `tailscale` invocation. */
export const defaultTailscaleCli = createTailscaleCli();

const resolvers = new Map<string, PublicIngressOriginResolver>();

/**
 * The process-wide resolver for this server's ports, memoized so its cache is
 * shared rather than re-created per call site.
 *
 * `STATION_UI_PORT` is included because a `tailscale serve` mapping for this
 * Station usually targets the sibling UI proxy, not the API: the proxy is what
 * a human browses to, and it forwards the pairing paths onward. A mapping to
 * either port is this Station, so either establishes the same public origin.
 */
export function publicIngressOriginResolver(
  serverPort: number,
  environment: NodeJS.ProcessEnv = process.env,
): PublicIngressOriginResolver {
  // Keyed by the ports it resolves, not by `serverPort` alone: memoizing on
  // the port while accepting an `environment` argument would silently ignore
  // that argument on every later call, which is a trap for a test that passes
  // one. In production `process.env` is constant and this is a single entry.
  const uiPortValue = Number(environment.STATION_UI_PORT);
  const key = `${serverPort}:${environment.STATION_UI_PORT ?? ''}`;
  const existing = resolvers.get(key);
  if (existing) return existing;
  const localPorts = [
    serverPort,
    ...(Number.isInteger(uiPortValue) && uiPortValue > 0 ? [uiPortValue] : []),
  ];
  const created = createPublicIngressOriginResolver({
    localPorts,
    cli: defaultTailscaleCli,
  });
  resolvers.set(key, created);
  return created;
}
