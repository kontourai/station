import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TAILSCALE_COMMAND_TIMEOUT_MS = 10_000;
const TAILSCALE_PROBE_TIMEOUT_MS = 5_000;

export interface TailscaleCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type TailscaleCommand = (
  args: readonly string[],
) => Promise<TailscaleCommandResult>;

export type TailscaleEndpointProbe = (
  endpoint: string,
  environmentId: string,
) => Promise<'same-station' | 'different-station' | 'unreachable'>;

export interface TailscaleOfferDependencies {
  command?: TailscaleCommand;
  probe?: TailscaleEndpointProbe;
}

export interface TailscaleOfferEndpoint {
  endpoint: string;
  /** True only when this invocation changed the HTTPS Serve mapping. */
  configured: boolean;
}

async function runTailscale(
  args: readonly string[],
): Promise<TailscaleCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync('tailscale', args, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
      timeout: TAILSCALE_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const result = error as {
      code?: number | string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      exitCode: typeof result.code === 'number' ? result.code : null,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
    };
  }
}

async function probeTailscaleEndpoint(
  endpoint: string,
  environmentId: string,
): Promise<'same-station' | 'different-station' | 'unreachable'> {
  try {
    const response = await fetch(`${endpoint}/.well-known/station/v1`, {
      redirect: 'error',
      signal: AbortSignal.timeout(TAILSCALE_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return 'unreachable';
    const value = (await response.json()) as { environmentId?: unknown };
    return value.environmentId === environmentId
      ? 'same-station'
      : 'different-station';
  } catch {
    return 'unreachable';
  }
}

function parseJson(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(
      `Tailscale returned invalid ${label} JSON. Refusing to publish a pairing endpoint.`,
    );
  }
}

function magicDnsOrigin(statusJson: string): string {
  const status = parseJson(statusJson, 'status');
  const self = status.Self;
  if (!self || typeof self !== 'object' || Array.isArray(self)) {
    throw new Error(
      'Tailscale status has no local machine identity. Start and connect tailscaled first.',
    );
  }
  const dnsName = (self as { DNSName?: unknown }).DNSName;
  if (typeof dnsName !== 'string') {
    throw new Error(
      'Tailscale MagicDNS is unavailable for this machine. Enable MagicDNS or offer without --tailscale.',
    );
  }
  const hostname = dnsName.replace(/\.$/, '').toLowerCase();
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
      hostname,
    ) ||
    !hostname.endsWith('.ts.net')
  ) {
    throw new Error(
      'Tailscale returned an invalid MagicDNS name. Refusing to publish a pairing endpoint.',
    );
  }
  if ((self as { Online?: unknown }).Online === false) {
    throw new Error(
      'Tailscale is not online for this machine. Connect tailscaled, then rerun the offer.',
    );
  }
  return `https://${hostname}`;
}

type ServeMapping =
  | { kind: 'none' }
  | { kind: 'proxy'; proxy: string }
  | { kind: 'foreign' };

function expectedWebListener(origin: string, servePort: number): string {
  return `${new URL(origin).hostname}:${servePort}`;
}

function rootProxy(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const handlers = (value as { Handlers?: unknown }).Handlers;
  if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) {
    return undefined;
  }
  const handlerEntries = Object.entries(handlers as Record<string, unknown>);
  if (handlerEntries.length !== 1 || handlerEntries[0]?.[0] !== '/') {
    return undefined;
  }
  const root = handlerEntries[0][1];
  if (!root || typeof root !== 'object' || Array.isArray(root))
    return undefined;
  const rootEntries = Object.entries(root as Record<string, unknown>);
  if (rootEntries.length !== 1 || rootEntries[0]?.[0] !== 'Proxy') {
    return undefined;
  }
  const proxy = rootEntries[0][1];
  return typeof proxy === 'string' ? proxy : undefined;
}

function httpsTcpCompanion(
  tcp: unknown,
  servePort: number,
): 'absent' | 'canonical' | 'foreign' {
  if (tcp === undefined) return 'absent';
  if (!tcp || typeof tcp !== 'object' || Array.isArray(tcp)) return 'foreign';
  const key = String(servePort);
  if (!Object.hasOwn(tcp, key)) return 'absent';
  const listener = (tcp as Record<string, unknown>)[key];
  if (!listener || typeof listener !== 'object' || Array.isArray(listener)) {
    return 'foreign';
  }
  const entries = Object.entries(listener as Record<string, unknown>);
  return entries.length === 1 &&
    entries[0]?.[0] === 'HTTPS' &&
    entries[0][1] === true
    ? 'canonical'
    : 'foreign';
}

function httpsServeMapping(
  serveJson: string,
  origin: string,
  servePort: number,
): ServeMapping {
  const status = parseJson(serveJson, 'Serve status');
  const tcpCompanion = httpsTcpCompanion(status.TCP, servePort);
  const listener = expectedWebListener(origin, servePort);
  const funnel = status.AllowFunnel;
  if (funnel !== undefined) {
    if (!funnel || typeof funnel !== 'object' || Array.isArray(funnel)) {
      return { kind: 'foreign' };
    }
    const funnelEntries = Object.entries(
      funnel as Record<string, unknown>,
    ).filter(([name]) => name.toLowerCase() === listener.toLowerCase());
    if (
      funnelEntries.length > 1 ||
      (funnelEntries.length === 1 && funnelEntries[0]?.[1] !== false)
    ) {
      return { kind: 'foreign' };
    }
  }
  const web = status.Web;
  if (web === undefined) {
    return tcpCompanion === 'absent' ? { kind: 'none' } : { kind: 'foreign' };
  }
  if (!web || typeof web !== 'object' || Array.isArray(web)) {
    return { kind: 'foreign' };
  }
  const entries = Object.entries(web as Record<string, unknown>);
  if (entries.length === 0) {
    return tcpCompanion === 'absent' ? { kind: 'none' } : { kind: 'foreign' };
  }
  const matchingEntries = entries.filter(
    ([name]) => name.toLowerCase() === listener.toLowerCase(),
  );
  // Other HTTPS listeners belong to other channels/uses. Inspect only the
  // requested port; an untouched 443 mapping must not block an 8444 offer.
  if (matchingEntries.length === 0) {
    return tcpCompanion === 'absent' ? { kind: 'none' } : { kind: 'foreign' };
  }
  if (matchingEntries.length !== 1) return { kind: 'foreign' };
  if (tcpCompanion === 'foreign') return { kind: 'foreign' };
  const selected = matchingEntries[0]?.[1];
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) {
    return { kind: 'foreign' };
  }
  const proxy = rootProxy(selected);
  return proxy ? { kind: 'proxy', proxy } : { kind: 'foreign' };
}

function isExpectedProxy(proxy: string, localApiBase: string): boolean {
  try {
    const actual = new URL(proxy);
    const expected = new URL(localApiBase);
    return (
      actual.protocol === 'http:' &&
      actual.protocol === expected.protocol &&
      actual.hostname === expected.hostname &&
      actual.port === expected.port &&
      (actual.pathname === '/' || actual.pathname === '') &&
      !actual.search &&
      !actual.hash
    );
  } catch {
    return false;
  }
}

function tailscaleFailure(
  action: string,
  result: TailscaleCommandResult,
): Error {
  const unavailable = result.exitCode === null;
  return new Error(
    unavailable
      ? `Tailscale CLI is unavailable while trying to ${action}. Install Tailscale and ensure \`tailscale\` is on PATH.`
      : `Tailscale could not ${action}. Check that tailscaled is running and authenticated, then rerun the offer.`,
  );
}

/**
 * Establishes the narrow Tailscale Serve mapping used by pairing. It never
 * overwrites an occupied HTTPS listener unless the live MagicDNS endpoint
 * proves it already serves this Station; an unreachable foreign-looking
 * mapping remains a refusal, not an invitation to clobber it.
 */
export async function resolveTailscaleOfferEndpoint(input: {
  localApiBase: string;
  environmentId: string;
  servePort?: number;
  dependencies?: TailscaleOfferDependencies;
}): Promise<TailscaleOfferEndpoint> {
  const local = new URL(input.localApiBase);
  if (
    local.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname) ||
    !local.port
  ) {
    throw new Error(
      'Tailscale pairing requires a live loopback Station API with an explicit port.',
    );
  }
  const servePort = input.servePort ?? 443;
  if (!Number.isInteger(servePort) || servePort < 1 || servePort > 65535) {
    throw new Error(
      'Tailscale Serve port must be an integer from 1 through 65535.',
    );
  }
  const command = input.dependencies?.command ?? runTailscale;
  const probe = input.dependencies?.probe ?? probeTailscaleEndpoint;
  const status = await command(['status', '--json']);
  if (status.exitCode !== 0)
    throw tailscaleFailure('read Tailscale status', status);
  const origin = magicDnsOrigin(status.stdout);
  const endpoint = servePort === 443 ? origin : `${origin}:${servePort}`;

  const serve = await command(['serve', 'status', '--json']);
  if (serve.exitCode !== 0) {
    throw tailscaleFailure('read the HTTPS Serve configuration', serve);
  }
  const mapping = httpsServeMapping(serve.stdout, origin, servePort);
  const reachability = await probe(endpoint, input.environmentId);

  if (reachability === 'different-station') {
    throw new Error(
      `The MagicDNS endpoint ${endpoint} reaches a different Station environment. Refusing to overwrite its HTTPS Serve mapping.`,
    );
  }
  if (mapping.kind === 'foreign') {
    throw new Error(
      `Tailscale HTTPS Serve on ${endpoint} already has a foreign or unrecognized mapping. Refusing to overwrite it; inspect with \`tailscale serve status --json\`.`,
    );
  }
  if (mapping.kind === 'proxy') {
    if (reachability === 'same-station') {
      // The live identity handshake through the public origin is the
      // STRONGER proof, and it must be consulted before port equality: a
      // Serve mapping that fronts the UI listener (which proxies API routes)
      // answers as this exact Station while pointing at a different loopback
      // port. Refusing it on port mismatch rejected healthy publications and
      // pushed operators to swap a working UI mapping over to the bare API —
      // replacing the browser publication with a narrower one (#2284). A
      // proven-identical Station keeps its mapping untouched.
      return { endpoint, configured: false };
    }
    if (!isExpectedProxy(mapping.proxy, input.localApiBase)) {
      throw new Error(
        `Tailscale HTTPS Serve on ${endpoint} is not provably this Station. Refusing to overwrite it; inspect with \`tailscale serve status --json\`.`,
      );
    }
    // An unreachable listener is repairable only after the configured proxy
    // independently proves it already targets this exact Station loopback.
    // Re-running the idempotent command can then restore reachability without
    // clobbering a foreign local service.
  }

  const publish = await command([
    'serve',
    '--bg',
    `--https=${servePort}`,
    local.origin,
  ]);
  if (publish.exitCode !== 0) {
    throw tailscaleFailure('configure HTTPS Serve', publish);
  }
  return { endpoint, configured: true };
}
