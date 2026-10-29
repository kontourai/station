// UNWIRED(#4115): R2a command implementation; the environment entry point refuses until R6.
import { randomBytes } from 'node:crypto';
import { parseCoreArgs } from './core-api.js';
import { terminalSafeJson } from './terminal-safe.js';

/** SUNSET(#4115): remove only in the reviewed R6 release change. No runtime switch. */
export function assertOutsideClientsAvailable(): void {
  throw new Error(
    'Outside-agent clients are not yet available. Host commands remain disabled until R6 qualification (#4115).',
  );
}
export interface OutsideClientsChannel {
  request(path: string, init?: RequestInit): Promise<unknown>;
}
interface Dependencies {
  openChannel(): Promise<OutsideClientsChannel>;
  write(line: string): void;
  confirm?: (question: string) => Promise<boolean>;
  now?: () => number;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Station returned a malformed outside-client response.');
  return value as Record<string, unknown>;
}
const usage = () =>
  new Error(
    'Usage: station environment outside-clients list | approve <request-id> (--project <slug>|--global) | deny <request-id> | change <grant-id> (--project <slug>|--global) | revoke <grant-id> | register --name <label> --redirect-uri <uri> | redirect-origins|cors-origins list|add|remove [https-origin]',
  );
const identifier = (value: string | undefined) => {
  if (!value || !/^[A-Za-z0-9_-]{20,128}$/.test(value))
    throw new Error(
      'An exact request or grant ID is required. Comparison codes are display-only and cannot be entered.',
    );
  return value;
};

export async function runOutsideClientsCommand(
  args: string[],
  deps: Dependencies,
): Promise<void> {
  const parsed = parseCoreArgs(args);
  const [verb, operand, extra] = parsed.positionals;
  const flags = parsed.flags;
  const permitted = [
    'api-base',
    'station',
    'project',
    'global',
    'access',
    'expires-in',
    'client-id',
    'request-fingerprint',
    'supersede',
    'force',
    'name',
    'redirect-uri',
    'application-type',
  ];
  if (
    !Object.keys(flags).every((f) => permitted.includes(f)) ||
    Object.values(parsed.repeatedFlags).some((values) => values.length > 1) ||
    parsed.positionals.length > 3
  )
    throw usage();
  const text = (key: string) => {
    const value = flags[key];
    if (typeof value !== 'string' || value.length === 0)
      throw new Error(`--${key} needs a value.`);
    return value;
  };
  const selectedProject = () => {
    if ((flags.global === true) === (typeof flags.project === 'string'))
      throw new Error(
        'Choose exactly one existing --project <slug> or explicit --global.',
      );
    return flags.global === true
      ? { kind: 'global' }
      : { kind: 'project', slug: text('project') };
  };
  const access = flags.access ?? 'read-only';
  if (access !== 'read-only')
    throw new Error(
      'Only read-only outside-client access is available before F1.',
    );
  const ttl = flags['expires-in'] ?? '30d';
  if (typeof ttl !== 'string' || !/^\d+(m|h|d)$/.test(ttl))
    throw new Error('--expires-in must be a duration such as 30d.');
  const expiresAt =
    (deps.now ?? Date.now)() +
    Number(ttl.slice(0, -1)) *
      ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[ttl.slice(-1)] ?? 0);
  let action: Record<string, unknown> | undefined;
  const mutations = ['approve', 'deny', 'change', 'revoke', 'register'];
  if (
    !['list', 'redirect-origins', 'cors-origins', ...mutations].includes(
      verb ?? '',
    )
  )
    throw usage();
  if (
    mutations.includes(verb!) &&
    ['approve', 'deny', 'change', 'revoke'].includes(verb!)
  )
    identifier(operand);
  if (['approve', 'change'].includes(verb!)) selectedProject();
  if (
    (mutations.includes(verb!) &&
      (verb === 'register' ? !!operand : !operand || !!extra)) ||
    (verb === 'list' && !!operand)
  )
    throw usage();
  if (
    ['redirect-origins', 'cors-origins'].includes(verb!) &&
    (!['list', 'add', 'remove'].includes(operand ?? '') ||
      (operand === 'list' ? !!extra : !extra))
  )
    throw usage();
  // Validate every noninteractive approval binding before opening any host channel.
  if (
    verb === 'approve' &&
    !deps.confirm &&
    (typeof flags['client-id'] !== 'string' ||
      typeof flags['request-fingerprint'] !== 'string' ||
      typeof flags.supersede !== 'string')
  )
    throw new Error(
      'Noninteractive approval requires --client-id, --request-fingerprint, and --supersede=none or explicit grant-id:version:digest selections from the host listing.',
    );
  const channel = await deps.openChannel();
  const get = async (path: string) => record(await channel.request(path));
  const post = async (path: string, value: unknown) =>
    record(
      await channel.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      }),
    );
  if (verb === 'list') {
    deps.write(terminalSafeJson(await get('/api/outside-agent/clients')));
    return;
  }
  let destination = '';
  if (verb === 'redirect-origins' || verb === 'cors-origins') {
    const path =
      verb === 'redirect-origins'
        ? '/api/outside-agent/redirect-origins'
        : '/api/outside-agent/cors-origins';
    const policy = await get(path);
    if (operand === 'list') {
      deps.write(terminalSafeJson(policy));
      return;
    }
    action = {
      operation: 'origin',
      policy: verb === 'redirect-origins' ? 'redirect' : 'cors',
      action: operand === 'add' ? 'add' : 'remove',
      origin: extra,
      expectedRevision: policy.revision,
    };
    destination = `${path}/change`;
  } else if (verb === 'register') {
    action = {
      operation: 'register',
      name: text('name'),
      redirectUri: text('redirect-uri'),
      applicationType: flags['application-type'] ?? 'native',
    };
    destination = '/api/outside-agent/host/register';
  } else {
    const listing = await get('/api/outside-agent/clients');
    if (verb === 'approve' || verb === 'deny') {
      const pending = listing.pending;
      const row = Array.isArray(pending)
        ? pending.map(record).find((r) => r.requestId === operand)
        : undefined;
      if (!row) throw new Error('No pending request has that exact ID.');
      if (
        (flags['client-id'] !== undefined &&
          flags['client-id'] !== row.clientId) ||
        (flags['request-fingerprint'] !== undefined &&
          flags['request-fingerprint'] !== row.expectedRequestFingerprint)
      )
        throw new Error(
          'Request or client changed; compare again in the host listing.',
        );
      action = {
        operation: verb,
        requestId: operand,
        clientId: row.clientId,
        expectedRequestFingerprint: row.expectedRequestFingerprint,
      };
      if (verb === 'approve') {
        const supersede = flags.supersede ?? 'none';
        if (typeof supersede !== 'string') throw usage();
        const supersessions =
          supersede === 'none'
            ? []
            : supersede.split(',').map((value) => {
                const [grantId, version, expectedDigest, ...rest] =
                  value.split(':');
                if (
                  rest.length ||
                  !expectedDigest ||
                  !/^\d+$/.test(version ?? '')
                )
                  throw new Error(
                    'Use explicit grant-id:version:digest supersessions, or none.',
                  );
                return {
                  grantId: identifier(grantId),
                  expectedVersion: Number(version),
                  expectedDigest,
                };
              });
        Object.assign(action, {
          project: selectedProject(),
          accessLevel: access,
          expiresAt,
          supersessions,
        });
      }
      destination =
        verb === 'approve'
          ? '/api/outside-agent/host/confirm'
          : '/api/outside-agent/host/deny';
    } else {
      const grants = listing.grants;
      const row = Array.isArray(grants)
        ? grants.map(record).find((r) => r.grantId === operand)
        : undefined;
      if (!row) throw new Error('No grant has that exact ID.');
      action = {
        operation: verb,
        grantId: operand,
        expectedVersion: row.version,
        expectedDigest: row.digest,
      };
      if (verb === 'change')
        Object.assign(action, {
          project: selectedProject(),
          accessLevel: access,
          expiresAt:
            flags['expires-in'] === undefined ? row.expiresAt : expiresAt,
        });
      destination = `/api/outside-agent/grants/${encodeURIComponent(operand!)}/${verb}`;
    }
  }
  const reviewed = await post('/api/outside-agent/host/review', { action });
  deps.write(terminalSafeJson(reviewed));
  if (typeof reviewed.fingerprint !== 'string')
    throw new Error('Station returned no review fingerprint.');
  // No prompt accepts a comparison code. Supersession is explicit and unselected by default.
  if (deps.confirm) {
    if (
      !(await deps.confirm(
        'Apply this reviewed outside-client decision? Selected supersessions disconnect only when the new login completes.',
      ))
    )
      throw new Error('Decision cancelled.');
  } else if (flags.force !== true && verb !== 'approve')
    throw new Error(
      'Noninteractive changes require --force after reviewing the host-channel output.',
    );
  const result = await post(destination, {
    action,
    fingerprint: reviewed.fingerprint,
    decisionId: randomBytes(32).toString('base64url'),
  });
  deps.write(terminalSafeJson(result));
  if (verb === 'register') {
    const resource = JSON.stringify(result.resource);
    const clientId = JSON.stringify(result.clientId);
    deps.write(
      `Stable public client ID (unverified identifier): ${clientId}\nResource: ${resource}\nConfigure Claude with --client-id and the registered --callback-port, or Codex with --oauth-client-id. Setup has not initiated login.`,
    );
  }
}
