import { PAIRING_SCOPE_ACCESS_MANAGE } from '@kontourai/station-contracts/environment-security';
import {
  STATION_CONTROL_EXTERNAL_CLIENT_TOOLS,
  type StationControlExternalClientLease,
  type StationControlExternalClientRequest,
} from '@kontourai/station-contracts/station-control-external-client';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  type StationControlCallerRecordResolver,
  stationControlExternalClientRecordBinding,
} from '../../runtime/mcp/station-control-caller.js';
import {
  buildStationControlMcpHeaderUrl,
  mintStationControlExternalClientLease,
  readStationControlExternalClientLease,
  revokeStationControlExternalClientLease,
} from '../../runtime/mcp/station-control-mcp-token.js';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  isBoundLocalGrantMintedOperator,
} from '../../security/runtime-request-security.js';
import type { DevicePairingService } from '../../services/ssh/device-pairing-service.js';
import { STATION_CONTROL_OPERATOR_PRINCIPAL_ID } from '../../tools/station-control-policy.js';

const NO_STORE = { 'Cache-Control': 'no-store' };
const requestSchema: z.ZodType<StationControlExternalClientRequest> = z
  .object({
    sessionId: z.string().min(1).max(256),
    allowedTools: z
      .array(z.enum(STATION_CONTROL_EXTERNAL_CLIENT_TOOLS))
      .min(1)
      .max(3)
      .refine((tools) => new Set(tools).size === tools.length),
    ttlSeconds: z.number().int().min(60).max(3600),
  })
  .strict();

/** Personal-host operator setup, not Session browser approval or remote OAuth. */
export function createStationControlExternalClientRoutes(options: {
  port: number;
  isHosted: () => boolean;
  resolveRecord: StationControlCallerRecordResolver;
  currentProjectId: (slug: string) => string | undefined;
  issuerAuthority: Pick<DevicePairingService, 'credentialHoldsScope'>;
}): Hono {
  const app = new Hono();
  app.use('/station-control/external-clients/*', async (c, next) => {
    const principal = getRuntimeAuthenticatedRequestPrincipal(c.req.raw);
    if (
      options.isHosted() ||
      principal?.kind !== 'credential' ||
      principal.authority !== 'device-credential' ||
      principal.deviceKind !== 'device' ||
      !principal.deviceId ||
      !isBoundLocalGrantMintedOperator(c.req.raw)
    )
      return c.json(
        { error: { code: 'local_operator_required' } },
        403,
        NO_STORE,
      );
    await next();
  });
  app.post('/station-control/external-clients', async (c) => {
    const authorityObservedAt = Date.now();
    const issuerDeviceId = getRuntimeAuthenticatedRequestPrincipal(
      c.req.raw,
    )?.deviceId;
    const body = await readBoundedRequestBody(c.req.raw, 4096);
    if (body.status !== 'ok')
      return c.json(
        { error: { code: 'invalid_lease_request' } },
        body.status === 'too-large' ? 413 : 400,
        NO_STORE,
      );
    let value: unknown;
    try {
      value = JSON.parse(body.body);
    } catch {
      return c.json(
        { error: { code: 'invalid_lease_request' } },
        400,
        NO_STORE,
      );
    }
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success)
      return c.json(
        { error: { code: 'invalid_lease_request' } },
        400,
        NO_STORE,
      );
    const record = options.resolveRecord(parsed.data.sessionId);
    const binding = stationControlExternalClientRecordBinding(record);
    if (
      !binding ||
      record?.principal?.id !== STATION_CONTROL_OPERATOR_PRINCIPAL_ID ||
      !record.localProjectId ||
      !record.projectSlug ||
      options.currentProjectId(record.projectSlug) !== record.localProjectId
    )
      return c.json(
        { error: { code: 'recorded_session_scope_required' } },
        403,
        NO_STORE,
      );
    const isIssuerCurrent = () =>
      !options.isHosted() &&
      typeof issuerDeviceId === 'string' &&
      options.issuerAuthority.credentialHoldsScope(
        issuerDeviceId,
        PAIRING_SCOPE_ACCESS_MANAGE,
        authorityObservedAt,
      );
    if (!isIssuerCurrent())
      return c.json(
        { error: { code: 'local_operator_required' } },
        403,
        NO_STORE,
      );
    const lease = mintStationControlExternalClientLease({
      sessionId: parsed.data.sessionId,
      ttlMs: parsed.data.ttlSeconds * 1000,
      allowedTools: parsed.data.allowedTools,
      callerRecordBinding: binding,
      isIssuerCurrent,
    });
    const data: StationControlExternalClientLease = {
      leaseId: lease.leaseId,
      sessionId: lease.sessionId,
      project: { id: record.localProjectId, slug: record.projectSlug },
      allowedTools: lease.allowedTools,
      expiresAt: new Date(lease.expiresAt).toISOString(),
      lifetime: 'process-and-session-bound',
      config: {
        url: buildStationControlMcpHeaderUrl(options.port),
        headers: { Authorization: `Bearer ${lease.token}` },
      },
    };
    return c.json({ success: true, data }, 201, NO_STORE);
  });
  app.delete('/station-control/external-clients/:leaseId', (c) => {
    const lease = readStationControlExternalClientLease(c.req.param('leaseId'));
    if (!lease)
      return c.json({ error: { code: 'lease_not_found' } }, 404, NO_STORE);
    // All leases this personal-only surface issues belong to the file-proven
    // operator. Revocation must remain possible after the Session disappears.
    revokeStationControlExternalClientLease(lease.leaseId);
    return c.json(
      { success: true, data: { revoked: true, leaseId: lease.leaseId } },
      200,
      NO_STORE,
    );
  });
  return app;
}
