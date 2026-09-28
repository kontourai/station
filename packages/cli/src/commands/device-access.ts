/**
 * #1796: the operator's device-access verbs, IAM-style — any grantable scope
 * on any paired device, full access (`approval:full-access`) being one of
 * them.
 *
 *   station environment access devices [--json]
 *   station environment access scope <device> --add=<scope,…> | --remove=<scope,…> | --set=<scope,…> [--dry-run]
 *   station environment access scopes [--json]
 *
 * Everything here speaks to Station through a {@link DeviceAccessOperatorChannel}
 * and never learns how the operator was authenticated. Today the only channel
 * is the Station host's own (`openLocalOperatorChannel` in environment.ts:
 * loopback proof, then the home's operator credential), so a paired remote
 * CLI cannot reach these verbs. A later remote operator session would supply
 * a different channel and reuse this module unchanged.
 *
 * The routes are the existing ones: `GET /api/pairing/devices` and
 * `POST /api/pairing/devices/:id/scope` (operator only). A scope change is
 * computed from the device's current scope and sent with `expectedScope`, so
 * a change another operator made meanwhile is refused, not overwritten.
 */
import {
  isPairingScopeGrantable,
  PAIRING_SCOPE_DESCRIPTIONS,
  PAIRING_SCOPES,
  type PairingScope,
  parsePairingScope,
} from '@kontourai/station-contracts/environment-security';
import { terminalSafeJson, terminalSafeText } from './terminal-safe.js';

/** How the verbs reach Station as its operator; how it authenticated is not their concern. */
export interface DeviceAccessOperatorChannel {
  request(path: string, init?: RequestInit): Promise<unknown>;
  /** The Station, as a person reads it ("Station \"home\" at http://…"). */
  readonly target: string;
}

export type DeviceScopeChange =
  | { readonly add: readonly PairingScope[] }
  | { readonly remove: readonly PairingScope[] }
  | { readonly set: readonly PairingScope[] };

export interface DeviceScopeArgs {
  /** A device id, a unique id prefix, or an exact name. */
  readonly selector: string;
  readonly change: DeviceScopeChange;
  readonly dryRun: boolean;
}

interface ParsedArgs {
  readonly flags: Record<string, string | boolean>;
  readonly positionals: readonly string[];
  readonly repeatedFlags: Record<string, string[]>;
}

/** The scope tokens a flag names: repeatable, and comma-separated. */
function scopeTokens(values: readonly string[]): string[] {
  return values
    .flatMap((value) => value.split(','))
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/** A token of the real vocabulary, or a refusal naming what exists. */
function knownScope(token: string): PairingScope {
  if ((PAIRING_SCOPES as readonly string[]).includes(token))
    return token as PairingScope;
  throw new Error(
    `Unknown scope "${terminalSafeText(token).slice(0, 64)}". Known scopes: ${PAIRING_SCOPES.join(', ')}. See: station environment access scopes`,
  );
}

/**
 * Parses `access scope` in full, before any Station is contacted: exactly one
 * of `--add`, `--remove`, `--set`; every token in the vocabulary; nothing
 * granted that the operator cannot grant to a device.
 */
export function parseDeviceScopeArgs(
  parsed: ParsedArgs,
  usageError: () => Error,
): DeviceScopeArgs {
  const allowed = ['api-base', 'station', 'add', 'remove', 'set', 'dry-run'];
  if (
    parsed.positionals.length !== 3 ||
    !Object.keys(parsed.flags).every((name) => allowed.includes(name)) ||
    (parsed.flags['dry-run'] !== undefined && parsed.flags['dry-run'] !== true)
  )
    throw usageError();
  const selector = parsed.positionals[2]!;
  const operations = (['add', 'remove', 'set'] as const).filter(
    (name) => parsed.flags[name] !== undefined,
  );
  if (operations.length !== 1)
    throw new Error('Choose exactly one of --add, --remove, or --set.');
  const operation = operations[0]!;
  if (parsed.flags[operation] === true)
    throw new Error(
      `--${operation} needs a scope, e.g. --${operation}=approval:full-access`,
    );
  const tokens = scopeTokens(parsed.repeatedFlags[operation] ?? []).map(
    knownScope,
  );
  if (tokens.length === 0)
    throw new Error(`--${operation} needs at least one scope.`);
  if (operation !== 'remove')
    for (const token of tokens)
      if (!isPairingScopeGrantable(token))
        throw new Error(
          `"${token}" cannot be granted to a device. Pairing decisions and peer-credential provisioning stay on the operator channel itself.`,
        );
  const unique = [...new Set(tokens)];
  return {
    selector,
    change:
      operation === 'add'
        ? { add: unique }
        : operation === 'remove'
          ? { remove: unique }
          : { set: unique },
    dryRun: parsed.flags['dry-run'] === true,
  };
}

/** What a device listing carries, as the scope route's list answers it. */
export interface DeviceAccessRow {
  readonly id: string;
  readonly name: string;
  readonly scope: string;
  readonly kind?: string;
  readonly lastUsedAt?: number;
  readonly revokedAt: number | null;
}

function parseDevice(value: unknown): DeviceAccessRow | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.scope !== 'string'
  )
    return undefined;
  return {
    id: record.id,
    name: record.name,
    scope: record.scope,
    ...(typeof record.kind === 'string' ? { kind: record.kind } : {}),
    ...(typeof record.lastUsedAt === 'number'
      ? { lastUsedAt: record.lastUsedAt }
      : {}),
    revokedAt: typeof record.revokedAt === 'number' ? record.revokedAt : null,
  };
}

/** The paired devices whose access is a live question (not revoked). */
export async function listPairedDevices(
  channel: DeviceAccessOperatorChannel,
): Promise<DeviceAccessRow[]> {
  const body = await channel.request('/api/pairing/devices');
  const devices =
    body && typeof body === 'object'
      ? (body as { devices?: unknown }).devices
      : undefined;
  if (!Array.isArray(devices))
    throw new Error('Station returned a malformed device list.');
  return devices
    .map(parseDevice)
    .filter(
      (device): device is DeviceAccessRow =>
        device !== undefined && device.revokedAt === null,
    );
}

const shortId = (id: string) => id.slice(0, 8);

function label(device: DeviceAccessRow): string {
  return `"${terminalSafeText(device.name)}" (${shortId(device.id)})`;
}

/**
 * A device named by exact id, by a unique id prefix, or by exact name, in
 * that order. Ambiguity refuses and names the candidates: a scope change
 * must land on exactly the device the operator meant.
 */
export function resolveDevice(
  devices: readonly DeviceAccessRow[],
  selector: string,
): DeviceAccessRow {
  const exact = devices.find((device) => device.id === selector);
  if (exact) return exact;
  const candidates = (
    predicate: (device: DeviceAccessRow) => boolean,
  ): DeviceAccessRow[] => devices.filter(predicate);
  for (const [how, matches] of [
    ['id prefix', candidates((device) => device.id.startsWith(selector))],
    ['name', candidates((device) => device.name === selector)],
  ] as const) {
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1)
      throw new Error(
        `"${terminalSafeText(selector).slice(0, 64)}" matches more than one paired device by ${how}: ${matches.map(label).join(', ')}. Use a longer id.`,
      );
  }
  throw new Error(
    `No paired device matches "${terminalSafeText(selector).slice(0, 64)}". List them with: station environment access devices`,
  );
}

/** The scope a change leaves, in the vocabulary's canonical order. */
export function nextDeviceScope(
  current: readonly PairingScope[],
  change: DeviceScopeChange,
): PairingScope[] {
  const next = new Set<PairingScope>('set' in change ? change.set : current);
  if ('add' in change) for (const token of change.add) next.add(token);
  if ('remove' in change) for (const token of change.remove) next.delete(token);
  return PAIRING_SCOPES.filter((token) => next.has(token));
}

export async function runDevicesCommand(
  channel: DeviceAccessOperatorChannel,
  options: { json: boolean },
  write: (line: string) => void,
): Promise<void> {
  const devices = await listPairedDevices(channel);
  if (options.json) {
    write(
      terminalSafeJson({
        devices: devices.map((device) => ({
          id: device.id,
          name: device.name,
          ...(device.kind ? { kind: device.kind } : {}),
          lastSeenAt: device.lastUsedAt
            ? new Date(device.lastUsedAt).toISOString()
            : null,
          scopes: device.scope.split(' '),
        })),
      }),
    );
    return;
  }
  if (devices.length === 0) {
    write(`No paired devices on ${channel.target}.`);
    return;
  }
  write(`Paired devices on ${channel.target}:`);
  for (const device of devices)
    write(
      `  ${shortId(device.id)}  ${terminalSafeText(device.name)}  last seen ${
        device.lastUsedAt ? new Date(device.lastUsedAt).toISOString() : 'never'
      }\n            scopes: ${device.scope}`,
    );
}

export async function runDeviceScopeCommand(
  channel: DeviceAccessOperatorChannel,
  args: DeviceScopeArgs,
  write: (line: string) => void,
): Promise<void> {
  const device = resolveDevice(await listPairedDevices(channel), args.selector);
  const current = parsePairingScope(device.scope);
  if (!current)
    throw new Error(
      `Device ${label(device)} holds a scope this CLI cannot read (${terminalSafeText(device.scope).slice(0, 256)}). Update the CLI, or change it in Station.`,
    );
  const next = nextDeviceScope(current, args.change);
  const before = current.join(' ');
  const after = next.join(' ');
  write(`Device ${label(device)} on ${channel.target}`);
  write(`  before: ${before}`);
  write(`  after:  ${after || '(none)'}`);
  if (next.length === 0)
    throw new Error(
      'A device must keep at least one scope. To remove its access entirely, revoke it in Station.',
    );
  if (after === before) {
    write('No change.');
    return;
  }
  if (args.dryRun) {
    write('Dry run: nothing was changed.');
    return;
  }
  let updated: DeviceAccessRow | undefined;
  try {
    updated = parseDevice(
      await channel.request(
        `/api/pairing/devices/${encodeURIComponent(device.id)}/scope`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: next, expectedScope: device.scope }),
        },
      ),
    );
  } catch (error) {
    if ((error as { code?: unknown }).code === 'scope_not_grantable')
      throw new Error(
        `Device ${label(device)} still holds a scope that cannot be granted to a device (access:manage, from an older default grant), so Station will not rewrite its access with it kept. Remove it in the same change, e.g. --set=<the scopes it should keep>, or remove it first with --remove=access:manage.`,
      );
    if ((error as { code?: unknown }).code === 'scope_changed')
      throw new Error(
        `Device ${label(device)}'s access changed since it was read (another change landed first). Nothing was overwritten. Rerun to apply your change to its current access.`,
      );
    throw error;
  }
  if (!updated || updated.id !== device.id || updated.scope !== after)
    throw new Error(
      'Station returned a mismatched device after the scope change. Check the device in Station.',
    );
  write(
    `Updated. Live terminal and voice connections of this device reconnect under the new access.`,
  );
}

/** The grantable scopes, from the contracts' own vocabulary and meanings. */
export function renderGrantableScopes(options: { json: boolean }): string {
  const rows = PAIRING_SCOPES.map((token) => ({
    scope: token,
    label: PAIRING_SCOPE_DESCRIPTIONS[token].label,
    meaning: PAIRING_SCOPE_DESCRIPTIONS[token].summary,
    grantable: isPairingScopeGrantable(token),
  }));
  if (options.json) return terminalSafeJson({ scopes: rows });
  return rows
    .map(
      (row) =>
        `${row.scope.padEnd(22)} ${row.label}${row.grantable ? '' : ' (not grantable to a device)'}\n${' '.repeat(23)}${row.meaning}`,
    )
    .join('\n');
}
