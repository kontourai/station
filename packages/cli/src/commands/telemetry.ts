import { closeSync, openSync, rmSync, writeFileSync } from 'node:fs';
import {
  TELEMETRY_TIERS,
  type TelemetryTierResolution,
} from '@kontourai/station-contracts/product-telemetry';
import {
  configureApiCredential,
  type ParsedCoreArgs,
  parseCoreArgs,
  requestJson,
  resolveApiBaseDetailed,
} from './core-api.js';

const PRODUCERS_USAGE = [
  'Usage: station telemetry producers create <name> [--allow-remote] [--expires-in-days=<n>] [--token-file=<path>]',
  '       station telemetry producers list',
  '       station telemetry producers revoke <name>',
].join('\n');

interface ProducerView {
  name: string;
  createdAt: string;
  expiresAt: string | null;
  expired: boolean;
  allowRemote: boolean;
  lastUsedAt: string | null;
}

/**
 * Opens the token file before the token exists: a path that cannot be
 * created (exists, missing directory, no permission) is refused before
 * Station mints a secret that would then be lost. `wx` refuses an existing
 * path, so a mistyped path never overwrites another file, and the file is
 * owner-only from creation.
 */
function openTokenFile(path: string): number {
  return openSync(path, 'wx', 0o600);
}

/**
 * Connection failures that happen before a request reaches the server:
 * nothing can have been created.
 */
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'ERR_INVALID_URL',
]);
/** Statuses a proxy or gateway may answer after the request reached Station. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);
/** SDK refusals raised before any request is sent. */
const NOT_SENT_ERRORS = new Set([
  'StationReadOnlyError',
  'StationCredentialConflictError',
]);

/**
 * Whether a failed create may still have created the producer. Station's own
 * refusal did not; nor did a failure before the request was sent. Anything
 * else (a gateway 502/503/504 without Station's envelope, a reset
 * connection, a timeout, a 2xx with no readable body) is ambiguous.
 */
function createMayHaveHappened(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  if (typeof status === 'number') {
    // A gateway in front of Station (the UI proxy, Tailscale Serve) can
    // answer 502/503/504 after Station already processed the create. Only
    // Station's own refusal envelope, which always names a `code`, proves
    // nothing was created.
    return (
      GATEWAY_STATUSES.has(status) &&
      typeof (error as { code?: unknown }).code !== 'string'
    );
  }
  if (error instanceof Error && NOT_SENT_ERRORS.has(error.name)) return false;
  for (
    let current: unknown = error, depth = 0;
    current && typeof current === 'object' && depth < 5;
    current = (current as { cause?: unknown }).cause, depth += 1
  ) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && NOT_SENT_CODES.has(code)) return false;
  }
  return true;
}

async function runProducersCommand(parsed: ParsedCoreArgs): Promise<void> {
  const [, action, name, ...extra] = parsed.positionals;
  const allowed: Record<string, readonly string[]> = {
    create: ['allow-remote', 'expires-in-days', 'token-file', 'json'],
    list: ['json'],
    revoke: ['json'],
  };
  const flags = Object.keys(parsed.flags).filter(
    (flag) => !['api-base', 'credential', 'station'].includes(flag),
  );
  if (
    !action ||
    !allowed[action] ||
    extra.length > 0 ||
    (action === 'list') !== (name === undefined) ||
    flags.some((flag) => !allowed[action]!.includes(flag)) ||
    // Switches are bare: `--allow-remote=true` must not silently mean
    // "this machine only".
    ['allow-remote', 'json'].some(
      (flag) => parsed.flags[flag] !== undefined && parsed.flags[flag] !== true,
    )
  )
    throw new Error(PRODUCERS_USAGE);
  const resolved = resolveApiBaseDetailed(parsed);
  configureApiCredential(parsed, resolved.apiBase);
  const json = parsed.flags.json === true;

  if (action === 'list') {
    const data = (await requestJson<{ producers: ProducerView[] }>(
      resolved.apiBase,
      '/api/telemetry-producers',
    )) as { producers: ProducerView[] };
    if (json) {
      console.log(JSON.stringify(data));
      return;
    }
    if (data.producers.length === 0) {
      console.log('No telemetry producers.');
      return;
    }
    for (const producer of data.producers)
      console.log(
        `${producer.name}\t${producer.allowRemote ? 'remote allowed' : 'this machine only'}\t${
          producer.expired
            ? 'expired'
            : producer.expiresAt
              ? `expires ${producer.expiresAt}`
              : 'no expiry'
        }\tlast used ${producer.lastUsedAt ?? 'never'}`,
      );
    return;
  }

  if (action === 'revoke') {
    await requestJson(
      resolved.apiBase,
      `/api/telemetry-producers/${encodeURIComponent(name!)}`,
      { method: 'DELETE' },
    );
    if (json) console.log(JSON.stringify({ revoked: name }));
    else console.log(`Revoked telemetry producer ${name}.`);
    return;
  }

  const expiresFlag = parsed.flags['expires-in-days'];
  let expiresInDays: number | null = null;
  if (expiresFlag !== undefined) {
    if (typeof expiresFlag !== 'string' || !/^\d+$/.test(expiresFlag))
      throw new Error('--expires-in-days=<n> takes a whole number of days.');
    expiresInDays = Number(expiresFlag);
  }
  const tokenFile = parsed.flags['token-file'];
  if (tokenFile !== undefined && (typeof tokenFile !== 'string' || !tokenFile))
    throw new Error('--token-file=<path> requires a path.');
  let descriptor: number | undefined;
  if (typeof tokenFile === 'string') {
    try {
      descriptor = openTokenFile(tokenFile);
    } catch (error) {
      throw new Error(
        `Cannot create ${tokenFile} (${(error as NodeJS.ErrnoException).code ?? 'error'}); choose a new path in an existing directory.`,
      );
    }
  }
  let data: { producer: ProducerView; token: string };
  try {
    try {
      data = (await requestJson<{ producer: ProducerView; token: string }>(
        resolved.apiBase,
        '/api/telemetry-producers',
        {
          method: 'POST',
          body: JSON.stringify({
            name,
            allowRemote: parsed.flags['allow-remote'] === true,
            expiresInDays,
          }),
        },
      )) as { producer: ProducerView; token: string };
    } catch (error) {
      // Only an ambiguous outcome (request sent, no usable reply) may hide
      // a created producer.
      if (!createMayHaveHappened(error)) throw error;
      throw new Error(
        `The create request did not complete (${error instanceof Error ? error.message : String(error)}). Telemetry producer ${name} may exist without a usable token: run \`station telemetry producers revoke ${name}\`, then create it again.`,
      );
    }
    if (descriptor !== undefined) {
      try {
        writeFileSync(descriptor, `${data.token}\n`, { encoding: 'utf8' });
      } catch (error) {
        throw new Error(
          `Telemetry producer ${data.producer.name} was created, but its token could not be written to ${tokenFile} (${(error as NodeJS.ErrnoException).code ?? 'error'}). Revoke it with \`station telemetry producers revoke ${data.producer.name}\` and create it again.`,
        );
      }
    }
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      descriptor = undefined;
      // Only the empty file this command created; the path was new.
      if (typeof tokenFile === 'string') rmSync(tokenFile, { force: true });
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const endpoint = `${resolved.apiBase}/v1/agent-events`;
  if (typeof tokenFile === 'string') {
    if (json)
      console.log(
        JSON.stringify({ producer: data.producer, tokenFile, endpoint }),
      );
    else
      console.log(
        `Created telemetry producer ${data.producer.name}. Token written to ${tokenFile} (mode 0600).\nEndpoint: ${endpoint}`,
      );
    return;
  }
  if (json) {
    console.log(
      JSON.stringify({ producer: data.producer, token: data.token, endpoint }),
    );
    return;
  }
  console.log(
    [
      `Created telemetry producer ${data.producer.name}.`,
      'Token (shown once; Station keeps only its hash):',
      data.token,
      `Endpoint: ${endpoint}`,
      'Send it as "Authorization: Bearer <token>".',
    ].join('\n'),
  );
}

export async function runTelemetryCommand(args: string[]): Promise<void> {
  const publisherFlag = args.indexOf('--publisher');
  if (
    publisherFlag !== -1 &&
    args[publisherFlag + 1] &&
    !args[publisherFlag + 1].startsWith('--')
  ) {
    args = [
      ...args.slice(0, publisherFlag),
      `--publisher=${args[publisherFlag + 1]}`,
      ...args.slice(publisherFlag + 2),
    ];
  }
  const parsed = parseCoreArgs(args);
  if (parsed.positionals[0] === 'producers') {
    await runProducersCommand(parsed);
    return;
  }
  const [action = 'status', publisher, tier, ...extra] = parsed.positionals;
  if (action === 'set') {
    if (
      !['kontour', 'operator'].includes(publisher) ||
      !TELEMETRY_TIERS.some((value) => value === tier) ||
      extra.length
    )
      throw new Error(
        'Usage: station telemetry set <kontour|operator> <off|lite|full>',
      );
    if (publisher === 'kontour' && tier === 'full')
      throw new Error(
        'Kontour Full is unavailable until a Kontour Full disclosure exists. Choose Off or Lite.',
      );
    if (parsed.flags.offline)
      throw new Error(
        'Telemetry choices require a running Station; use its authenticated configuration API.',
      );
  } else if (action === 'outbox') {
    if (
      publisher !== undefined ||
      (parsed.flags.publisher !== undefined &&
        !['kontour', 'operator'].includes(String(parsed.flags.publisher)))
    )
      throw new Error(
        'Usage: station telemetry outbox [--publisher=kontour|operator]',
      );
  } else if (action !== 'status' || publisher !== undefined) {
    throw new Error(
      'Usage: station telemetry status | station telemetry set <publisher> <tier> | station telemetry producers <create|list|revoke>',
    );
  }
  const resolved = resolveApiBaseDetailed(parsed);
  configureApiCredential(parsed, resolved.apiBase);
  if (action === 'outbox') {
    const filter =
      typeof parsed.flags.publisher === 'string'
        ? `?publisher=${encodeURIComponent(parsed.flags.publisher)}`
        : '';
    const entries = await requestJson<unknown[]>(
      resolved.apiBase,
      `/api/usage-telemetry/outbox${filter}`,
    );
    console.log(
      JSON.stringify(entries, null, parsed.flags.json ? undefined : 2),
    );
    return;
  }
  if (action === 'set')
    await requestJson(resolved.apiBase, '/config/app', {
      method: 'PUT',
      body: JSON.stringify({ telemetryTier: { [publisher]: tier } }),
    });
  const status = await requestJson<{
    publishers: Record<'kontour' | 'operator', TelemetryTierResolution>;
  }>(resolved.apiBase, '/api/usage-telemetry/status');
  if (!('publishers' in status))
    throw new Error('Telemetry status unavailable');
  if (parsed.flags.json) console.log(JSON.stringify(status));
  else
    for (const [name, value] of Object.entries(status.publishers))
      console.log(
        `${name}: ${value.tier} (${value.reason})${
          name === 'operator' && value.reason === 'environment'
            ? '; environment defaults cannot enable Full. Choose Full in config (station telemetry set operator full) and acknowledge the disclosure in Settings to send Full events.'
            : ''
        }`,
      );
}
