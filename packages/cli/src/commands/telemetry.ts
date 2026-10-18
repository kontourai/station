import {
  TELEMETRY_TIERS,
  type TelemetryTierResolution,
} from '@kontourai/station-contracts/product-telemetry';
import { isTelemetryPublisherId } from '@kontourai/station-shared/plugin-telemetry';
import {
  configureApiCredential,
  parseCoreArgs,
  requestJson,
  resolveApiBaseDetailed,
} from './core-api.js';

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
  const [action = 'status', publisher, tier, ...extra] = parsed.positionals;
  if (action === 'set') {
    if (
      !isTelemetryPublisherId(publisher) ||
      !TELEMETRY_TIERS.some((value) => value === tier) ||
      extra.length
    )
      throw new Error(
        'Usage: station telemetry set <kontour|operator|publisher:id> <off|lite|full>',
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
        !isTelemetryPublisherId(parsed.flags.publisher))
    )
      throw new Error(
        'Usage: station telemetry outbox [--publisher=kontour|operator|publisher:id]',
      );
  } else if (action !== 'status' || publisher !== undefined) {
    throw new Error(
      'Usage: station telemetry status | station telemetry set <publisher> <tier>',
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
