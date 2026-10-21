import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  parseStationControlExternalClientLease,
  STATION_CONTROL_EXTERNAL_CLIENT_TOOLS,
} from '@kontourai/station-contracts/station-control-external-client';
import {
  getResolvedApiBase,
  optionalValueFlag,
  type ParsedCoreArgs,
  printJson,
  requestJson,
} from './core-api.js';
import {
  isLoopbackSelfAuthEndpoint,
  selfAuthorizeLocalProfile,
} from './local-self-auth.js';
import { findProfile } from './profile-store.js';

const endpoint = '/api/orchestration/station-control/external-clients';

/** Uses the selected profile's normal credential path, never the internal token. */
export async function runMcpClientsCommand(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  if (!isLoopbackSelfAuthEndpoint(apiBase))
    throw new Error(
      'External-client setup requires an IP-literal loopback Station profile.',
    );
  const action = parsed.positionals[0];
  if (action === 'authorize') {
    const selected = getResolvedApiBase()?.station;
    const profile = selected ? findProfile(selected) : undefined;
    if (
      !profile ||
      new URL(profile.endpoint).origin !== new URL(apiBase).origin
    )
      throw new Error(
        'authorize requires a saved installed local Station selected with --station.',
      );
    const outcome = await selfAuthorizeLocalProfile(profile);
    if (outcome.status !== 'authorized') throw new Error(outcome.reason);
    printJson({
      authorized: true,
      station: outcome.profile.name,
      ...(outcome.warning ? { warning: outcome.warning } : {}),
    });
    return;
  }

  if (action === 'revoke') {
    const id = parsed.positionals[1];
    if (!id || !/^[a-f0-9]{32}$/.test(id))
      throw new Error('revoke requires the lease id returned by create.');
    let result: Awaited<
      ReturnType<typeof requestJson<{ revoked: boolean; leaseId: string }>>
    >;
    try {
      result = await requestJson<{ revoked: boolean; leaseId: string }>(
        apiBase,
        `${endpoint}/${id}`,
        { method: 'DELETE' },
      );
    } catch (error) {
      const status =
        error instanceof Error && 'status' in error ? error.status : undefined;
      if (typeof status === 'number' && status >= 400 && status < 500)
        throw error;
      throw new Error(
        'Lease revocation is unconfirmed. Do not retry automatically; retain the lease id and expiry.',
      );
    }
    if (
      !('revoked' in result) ||
      result.revoked !== true ||
      result.leaseId !== id
    )
      throw new Error(
        'Lease revocation is unconfirmed. Do not retry automatically.',
      );
    printJson({ revoked: true, leaseId: id });
    return;
  }
  if (action !== 'create') throw new Error('Use authorize, create or revoke.');
  if (process.platform === 'win32')
    throw new Error(
      'Private client-config output currently requires POSIX file permissions. No lease was requested.',
    );
  const sessionId = optionalValueFlag(parsed, 'session');
  const tools = optionalValueFlag(parsed, 'tools')
    ?.split(',')
    .map((name) => name.trim());
  const ttl = optionalValueFlag(parsed, 'ttl-seconds');
  const output = optionalValueFlag(parsed, 'output');
  if (
    !sessionId ||
    !tools?.length ||
    tools.some(
      (tool) =>
        !STATION_CONTROL_EXTERNAL_CLIENT_TOOLS.some((name) => name === tool),
    ) ||
    new Set(tools).size !== tools.length ||
    !ttl ||
    !/^\d+$/.test(ttl) ||
    Number(ttl) < 60 ||
    Number(ttl) > 3600 ||
    !output ||
    !isAbsolute(output)
  )
    throw new Error(
      'create requires --session, explicit --tools, --ttl-seconds=60..3600 and an absolute --output path.',
    );
  if (existsSync(output))
    throw new Error(
      'Client configuration output already exists; it was not overwritten.',
    );
  let result: unknown;
  try {
    result = await requestJson(apiBase, endpoint, {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        allowedTools: tools,
        ttlSeconds: Number(ttl),
      }),
    });
  } catch (error) {
    const status =
      error instanceof Error && 'status' in error ? error.status : undefined;
    if (typeof status === 'number' && status >= 400 && status < 500)
      throw error;
    throw new Error(
      'Lease issuance outcome is unknown. Do not retry automatically; any unrecorded lease expires within the requested lifetime.',
    );
  }
  const lease = parseStationControlExternalClientLease(result);
  let configUrl: URL | undefined;
  try {
    if (lease) configUrl = new URL(lease.config.url);
  } catch {
    /* Refuse an untrusted response below. */
  }
  if (
    !lease ||
    lease.sessionId !== sessionId ||
    JSON.stringify(lease.allowedTools) !== JSON.stringify(tools) ||
    configUrl?.origin !== new URL(apiBase).origin ||
    configUrl.pathname !== '/mcp/station-control' ||
    configUrl.search ||
    configUrl.hash ||
    configUrl.username ||
    configUrl.password
  )
    throw new Error(
      'Lease response is invalid or has different scope. No configuration was saved; do not retry automatically.',
    );
  try {
    const fd = openSync(output, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(lease, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    let revoked = false;
    try {
      const outcome = await requestJson<{ revoked: boolean; leaseId: string }>(
        apiBase,
        `${endpoint}/${lease.leaseId}`,
        { method: 'DELETE' },
      );
      revoked =
        'revoked' in outcome &&
        outcome.revoked === true &&
        outcome.leaseId === lease.leaseId;
    } catch {
      /* Preserve an uncertain compensation outcome; never mint again. */
    }
    throw new Error(
      revoked
        ? 'Could not save the private configuration; the issued lease was revoked.'
        : 'Could not save the private configuration; revocation is unconfirmed. Do not retry automatically; the lease remains bounded by its expiry.',
    );
  }
  const { config: _secretConfig, ...metadata } = lease;
  printJson({ ...metadata, configPath: output });
}
