/**
 * #1796: the operator's device-access verbs, IAM-style — any grantable scope
 * on any paired device, full access (`approval:full-access`) being one of
 * them.
 *
 *   station environment access devices [--json]
 *   station environment access scope <device> --add=<scope,…> | --remove=<scope,…> | --set=<scope,…> [--dry-run]
 *   station environment access scopes [--json]
 *   station environment access revoke <device> [--force]
 *   station environment access remove <device> [--force]
 *
 * Everything here speaks to Station through a {@link DeviceAccessOperatorChannel}
 * and never learns how the operator was authenticated. Today the only channel
 * is the Station host's own (`openLocalOperatorChannel` in environment.ts:
 * loopback proof, then the home's operator credential), so a paired remote
 * CLI cannot reach these verbs. A later remote operator session would supply
 * a different channel and reuse this module unchanged.
 *
 * The routes are the existing ones: `GET /api/pairing/devices`,
 * `POST /api/pairing/devices/:id/scope`, `DELETE /api/pairing/devices/:id`
 * (revoke) and `DELETE /api/pairing/devices/:id/record` (remove a revoked
 * record), all operator only. A scope change is
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
import { sanitizeUntrustedDisplayText } from '@kontourai/station-contracts/orchestration';
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
  if (selector.trim() === '') throw usageError();
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

/**
 * The paired devices whose access is a live question (not revoked), or with
 * `{ revoked: true }` only the revoked records (what `remove` may delete).
 */
async function listPairedDevices(
  channel: DeviceAccessOperatorChannel,
  options: { revoked?: boolean } = {},
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
        device !== undefined &&
        (device.revokedAt !== null) === (options.revoked === true),
    );
}

const shortId = (id: string) => id.slice(0, 8);

/** The device by name and its FULL id, for a prompt about something irreversible. */
function fullLabel(device: DeviceAccessRow): string {
  return `"${terminalSafeText(device.name)}" (${terminalSafeText(device.id)})`;
}

function label(device: DeviceAccessRow): string {
  return `"${terminalSafeText(device.name)}" (${shortId(device.id)})`;
}

/**
 * A device named by exact id, by a unique id prefix, or by exact name, in
 * that order. Ambiguity refuses and names the candidates: a scope change
 * must land on exactly the device the operator meant.
 */
function resolveDevice(
  devices: readonly DeviceAccessRow[],
  selector: string,
  noMatch = `No paired device matches "${terminalSafeText(selector).slice(0, 64)}". List them with: station environment access devices`,
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
  throw new Error(noMatch);
}

/** The scope a change leaves, in the vocabulary's canonical order. */
function nextDeviceScope(
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
  // #1796 H3: `--remove approval:full-access` on a device that no longer
  // holds it re-runs the reset of what its full access had granted (a reset
  // that failed after the scope change). The scope itself is unchanged.
  const retryReset =
    after === before &&
    'remove' in args.change &&
    args.change.remove.includes('approval:full-access') &&
    !current.includes('approval:full-access');
  if (after === before && !retryReset) {
    write('No change.');
    return;
  }
  if (retryReset)
    write(
      'It no longer holds approval:full-access: resetting the conversations its full access had given, again.',
    );
  if (args.dryRun) {
    write('Dry run: nothing was changed.');
    return;
  }
  let updated: DeviceAccessRow | undefined;
  let answer: unknown;
  try {
    answer = await channel.request(
      `/api/pairing/devices/${encodeURIComponent(device.id)}/scope`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: next,
          expectedScope: device.scope,
          ...(retryReset ? { resetFullAccess: true } : {}),
        }),
      },
    );
    updated = parseDevice(answer);
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
  reportFullAccessRevocation(answer, write);
}

export interface DeviceRemovalArgs {
  readonly selector: string;
  /** `--force`: the operator's typed approval, for a run with no terminal to ask. */
  readonly force: boolean;
}

/**
 * Parses `access revoke` / `access remove` in full, before any Station is
 * contacted: one selector, and only the target and `--force` flags.
 */
export function parseDeviceRemovalArgs(
  parsed: ParsedArgs,
  usageError: () => Error,
): DeviceRemovalArgs {
  const allowed = ['api-base', 'station', 'force'];
  if (
    parsed.positionals.length !== 3 ||
    !Object.keys(parsed.flags).every((name) => allowed.includes(name)) ||
    (parsed.flags.force !== undefined && parsed.flags.force !== true) ||
    // `startsWith('')` would match a lone device.
    parsed.positionals[2]!.trim() === ''
  )
    throw usageError();
  return {
    selector: parsed.positionals[2]!,
    force: parsed.flags.force === true,
  };
}

/** Asks the operator; `null` when there is nobody to ask (no terminal). */
export type DeviceRemovalConfirm =
  | ((question: string) => Promise<boolean>)
  | null;

/**
 * Both verbs end the device's record of access and are not undone by rerunning
 * anything, so each is approved by `--force` or a person at a terminal, and a
 * run with neither is refused before Station is contacted.
 */
export function requireDeviceRemovalApproval(
  args: DeviceRemovalArgs,
  verb: 'revoke' | 'remove',
  confirm: DeviceRemovalConfirm,
): void {
  if (!args.force && !confirm)
    throw new Error(
      `access ${verb} is destructive and requires --force when stdin is non-interactive.`,
    );
}

async function approve(
  args: DeviceRemovalArgs,
  confirm: DeviceRemovalConfirm,
  question: string,
): Promise<boolean> {
  return args.force ? true : confirm ? confirm(question) : false;
}

/** The answer must name the device the operator chose, and that it is now revoked. */
function requireRevokedDevice(
  answer: unknown,
  device: DeviceAccessRow,
  what: string,
): void {
  const named = parseDevice(answer);
  if (!named || named.id !== device.id || named.revokedAt === null)
    throw new Error(
      `Station returned a mismatched device after ${what}. Check the device in Station.`,
    );
}

export async function runDeviceRevokeCommand(
  channel: DeviceAccessOperatorChannel,
  args: DeviceRemovalArgs,
  confirm: DeviceRemovalConfirm,
  write: (line: string) => void,
): Promise<void> {
  const device = resolveDevice(await listPairedDevices(channel), args.selector);
  write(`Device ${label(device)} on ${channel.target}`);
  write(`  scopes: ${device.scope}`);
  if (
    !(await approve(
      args,
      confirm,
      `Revoke ${fullLabel(device)}? Its access ends immediately and cannot be restored; it can pair again later. Continue?`,
    ))
  )
    throw new Error(
      'Not revoked: the revoke was not approved. Nothing was changed.',
    );
  const answer = await channel.request(
    `/api/pairing/devices/${encodeURIComponent(device.id)}`,
    { method: 'DELETE' },
  );
  requireRevokedDevice(answer, device, 'the revoke');
  write(
    'Revoked. Its live terminal and voice connections are closed, and it can pair again later.',
  );
  reportFullAccessRevocation(answer, write, 'revoked');
}

export async function runDeviceRemoveCommand(
  channel: DeviceAccessOperatorChannel,
  args: DeviceRemovalArgs,
  confirm: DeviceRemovalConfirm,
  write: (line: string) => void,
): Promise<void> {
  const device = resolveDevice(
    await listPairedDevices(channel, { revoked: true }),
    args.selector,
    `No revoked device record matches "${terminalSafeText(args.selector).slice(0, 64)}". A device that is still paired is revoked first: station environment access revoke <device>`,
  );
  write(`Revoked device ${label(device)} on ${channel.target}`);
  if (
    !(await approve(
      args,
      confirm,
      `Delete the revoked record of ${fullLabel(device)}? The record cannot be restored. Continue?`,
    ))
  )
    throw new Error(
      'Not removed: the removal was not approved. Nothing was changed.',
    );
  const answer = await channel.request(
    `/api/pairing/devices/${encodeURIComponent(device.id)}/record`,
    { method: 'DELETE' },
  );
  requireRevokedDevice(answer, device, 'the record removal');
  write('Removed the revoked record.');
}

const RESET_WAS: Record<string, string> = {
  never: 'its full-access decision',
  'default-reaching-full-access':
    'its Default pick, which resolved to full access',
  'host-start': 'a session it started at full access',
  'auto-on-host': 'its Auto decision on a session its grant had unconfined',
};
const UNCONFINED_UNTIL: Record<string, string> = {
  'next-turn':
    'its engine is running: a turn already running finishes unconfined, and its next turn runs confined',
  // Sent by Stations from before #2898.
  'engine-restart':
    'its engine is running with no decision to re-apply, so it keeps its starting posture until it restarts',
  'grant-not-checked': 'this Station does not re-check the grant at each turn',
};
const STILL_REASON: Record<string, string> = {
  'operator-decision': "the operator's own decision",
  'another-device-decision': "another device's decision",
  'unattributed-decision': 'a decision with no recorded author (older Station)',
  'agent-default': "the Agent's default approval mode",
  'station-default': "the Station's default approval mode",
};

/**
 * #1796 (G3): what removing full access reset, and what stays at full
 * access for another reason. A reset that failed on the Station is an error.
 */
function reportFullAccessRevocation(
  answer: unknown,
  write: (line: string) => void,
  change: 'scope changed' | 'revoked' = 'scope changed',
): void {
  const record =
    answer && typeof answer === 'object'
      ? (answer as Record<string, unknown>)
      : {};
  if (record.fullAccessRevocationError !== undefined)
    throw new Error(
      `${change === 'revoked' ? 'The device was revoked' : 'The scope was changed'}, but Station could not reset the conversations this device had put at full access. They keep their current approval mode until someone changes it. Check the Station log.`,
    );
  const report = record.fullAccessRevocation as
    | {
        reset?: Array<{
          conversationId?: unknown;
          title?: unknown;
          was?: unknown;
        }>;
        stillFullAccess?: Array<{
          conversationId?: unknown;
          title?: unknown;
          reason?: unknown;
        }>;
        reconfined?: Array<{ conversationId?: unknown }>;
        stillUnconfined?: Array<{
          conversationId?: unknown;
          title?: unknown;
          until?: unknown;
        }>;
        unattributedHostStarts?: {
          sessions?: Array<{
            conversationId?: unknown;
            title?: unknown;
            startedAt?: unknown;
          }>;
          total?: unknown;
        };
      }
    | undefined;
  if (!report || typeof report !== 'object') return;
  const reset = Array.isArray(report.reset) ? report.reset : [];
  const still = Array.isArray(report.stillFullAccess)
    ? report.stillFullAccess
    : [];
  const unattributed = Array.isArray(report.unattributedHostStarts?.sessions)
    ? report.unattributedHostStarts.sessions
    : [];
  const unattributedTotal =
    typeof report.unattributedHostStarts?.total === 'number'
      ? report.unattributedHostStarts.total
      : unattributed.length;
  const id = (value: unknown) => terminalSafeText(String(value)).slice(0, 128);
  // A conversation by title, where it has one, then its id. A title comes
  // from session content: bidi and zero-width characters are stripped (not
  // just escaped) so it cannot pass itself off as another conversation.
  const named = (entry: { conversationId?: unknown; title?: unknown }) => {
    const title =
      typeof entry.title === 'string'
        ? sanitizeUntrustedDisplayText(entry.title, 256)
        : '';
    return title
      ? `"${id(title)}" ${id(entry.conversationId)}`
      : id(entry.conversationId);
  };
  const reconfined = Array.isArray(report.reconfined) ? report.reconfined : [];
  const unconfined = Array.isArray(report.stillUnconfined)
    ? report.stillUnconfined
    : [];
  if (
    reset.length === 0 &&
    still.length === 0 &&
    unattributed.length === 0 &&
    reconfined.length === 0 &&
    unconfined.length === 0
  ) {
    write('No conversation was at full access through this device.');
    return;
  }
  if (reset.length > 0) {
    write(
      'Reset to Ask (a turn already running finishes first; the next one asks):',
    );
    for (const entry of reset)
      write(
        `  ${named(entry)}  was: ${RESET_WAS[String(entry.was)] ?? id(entry.was)}`,
      );
  }
  if (still.length > 0) {
    write('Still at full access, not changed:');
    for (const entry of still)
      write(
        `  ${named(entry)}  because of ${STILL_REASON[String(entry.reason)] ?? id(entry.reason)}`,
      );
  }
  if (reconfined.length > 0) {
    write('Re-confined from its next turn (runs inside the workspace again):');
    for (const entry of reconfined) write(`  ${named(entry)}`);
  }
  if (unconfined.length > 0) {
    write('Still unconfined:');
    for (const entry of unconfined)
      write(
        `  ${named(entry)}  because ${UNCONFINED_UNTIL[String(entry.until)] ?? id(entry.until)}`,
      );
  }
  if (unattributed.length > 0) {
    write(
      'Unattributed host start: still at full access, not changed (started before Station recorded who granted it; it may be this device):',
    );
    for (const entry of unattributed)
      write(`  ${named(entry)}  started ${id(entry.startedAt)}`);
    if (unattributedTotal > unattributed.length)
      write(
        `  … and ${unattributedTotal - unattributed.length} more (${unattributedTotal} in all).`,
      );
  }
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
