import { closeSync, existsSync, openSync, writeFileSync } from 'node:fs';
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
 * Writes the secret to a new owner-only file. Refuses an existing path, so a
 * mistyped path never overwrites another file and a token is never written
 * into a file other users can already read.
 */
function writeTokenFile(path: string, token: string): void {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${token}\n`, { encoding: 'utf8' });
  } finally {
    closeSync(descriptor);
  }
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
    flags.some((flag) => !allowed[action]!.includes(flag))
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
  if (typeof tokenFile === 'string' && existsSync(tokenFile))
    throw new Error(
      `${tokenFile} already exists; choose a new path for the token file.`,
    );
  const data = (await requestJson<{ producer: ProducerView; token: string }>(
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
  const endpoint = `${resolved.apiBase}/v1/agent-events`;
  if (typeof tokenFile === 'string') {
    writeTokenFile(tokenFile, data.token);
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
  } else if (action !== 'status' || publisher !== undefined) {
    throw new Error(
      'Usage: station telemetry status | station telemetry set <publisher> <tier> | station telemetry producers <create|list|revoke>',
    );
  }
  const resolved = resolveApiBaseDetailed(parsed);
  configureApiCredential(parsed, resolved.apiBase);
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
