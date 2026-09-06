import type { DatabaseSync } from 'node:sqlite';
import type {
  PairedHomeIdentityObservation,
  PersonalHomeDecisionObservation,
} from '@kontourai/station-contracts/cloud-move';
import {
  PAIRING_SCOPE_HOME_TRANSFER,
  pairingScopeIncludes,
} from '@kontourai/station-contracts/environment-security';
import { Hono } from 'hono';
import { createPersonalRuntimeRequestGuard } from '../../runtime/bootstrap/runtime-tenant-context.js';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { currentHomeTransferDevice } from '../../security/home-transfer-request.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import { createPairedHomeTransferAuthority } from '../../services/orchestration/paired-home-transfer-authority.js';
import type {
  PlannedHomeOwner,
  PlannedHomeTransfer,
  TransferStoreResult,
} from '../../services/orchestration/planned-home-transfer-store.js';
import type { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';

/** Observe a separately paired transfer participant on this controller.
 * Optional personal decision preparation; no tenant membership, lease or activation API. */
export function createHomeAuthorityRoutes(
  security: Pick<
    EnvironmentSecurityService,
    | 'identifyDevice'
    | 'getPublicHandshake'
    | 'verifyOperatorCredential'
    | 'devicePairing'
  >,
  openDatabase?: () => DatabaseSync,
) {
  function projectDecision(
    result: TransferStoreResult<PlannedHomeOwner | PlannedHomeTransfer>,
  ): TransferStoreResult<PersonalHomeDecisionObservation> {
    if (result.kind !== 'stored') return result;
    const stored = result.value;
    const common = {
      schemaVersion: 'station.personal-home-decision/v1' as const,
      executionAuthorityTransferred: false as const,
      executionResumeAvailable: false as const,
    };
    if ('intent' in stored) {
      const {
        channelId,
        operationId,
        sourceHomeRef,
        targetHomeRef,
        policyRevision,
        expectedRevision,
      } = stored.intent;
      return {
        kind: 'stored',
        value: {
          ...common,
          kind: 'transfer-decision',
          channelId,
          operationId,
          sourceHomeRef,
          targetHomeRef,
          policyRevision,
          expectedRevision,
          phase: stored.phase,
        },
      };
    }
    const { channelId, homeRef, policyRevision, revision } = stored;
    return {
      kind: 'stored',
      value: {
        ...common,
        kind: 'owner-binding',
        channelId,
        homeRef,
        policyRevision,
        revision,
      },
    };
  }
  const app = new Hono();
  const personal = createPersonalRuntimeRequestGuard();
  app.get('/identity', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!personal(c.req.raw)) {
      return c.json(
        { error: { code: 'home_authority_tenant_binding_required' } },
        403,
      );
    }
    const principal = getRuntimeAuthenticatedRequestPrincipal(c.req.raw);
    if (principal?.authority !== 'device-credential' || !principal.deviceId) {
      return c.json({ error: { code: 'home_transfer_pairing_required' } }, 403);
    }
    const current = () =>
      personal(c.req.raw) &&
      currentHomeTransferDevice(c.req.raw, security)?.id === principal.deviceId;

    try {
      if (!current()) {
        return c.json(
          { error: { code: 'home_transfer_pairing_required' } },
          403,
        );
      }
      const controller = await security.getPublicHandshake();
      // Pairing can be revoked while reading controller identity. Never publish
      // an enrollment observation under the old request authentication alone.
      if (!current()) {
        return c.json(
          { error: { code: 'home_transfer_pairing_required' } },
          403,
        );
      }
      const observation: PairedHomeIdentityObservation = {
        schemaVersion: 'station.paired-home-identity/v1',
        controllerEnvironmentId: controller.environmentId,
        pairedDeviceId: principal.deviceId,
        scope: 'personal',
        executionAuthorityTransferred: false,
        executionResumeAvailable: false,
      };
      return c.json(observation);
    } catch {
      return c.json({ error: { code: 'home_authority_unavailable' } }, 503);
    }
  });
  async function decision<T>(
    request: Request,
    run: (
      authority: ReturnType<typeof createPairedHomeTransferAuthority>,
      principal: NonNullable<
        ReturnType<typeof getRuntimeAuthenticatedRequestPrincipal>
      >,
    ) => TransferStoreResult<T>,
  ): Promise<TransferStoreResult<T>> {
    const principal = getRuntimeAuthenticatedRequestPrincipal(request);
    if (!principal || !personal(request)) return { kind: 'denied' };
    if (!openDatabase) return { kind: 'unavailable' };
    try {
      const controller = await security.getPublicHandshake();
      if (!personal(request)) return { kind: 'denied' };
      const paired = security.identifyDevice(principal.credential);
      const operator =
        principal.authority === 'operator-credential' &&
        security.verifyOperatorCredential(principal.credential);
      if (
        !operator &&
        !(
          principal.authority === 'device-credential' &&
          paired?.id === principal.deviceId &&
          paired &&
          pairingScopeIncludes(paired.scope, PAIRING_SCOPE_HOME_TRANSFER)
        )
      )
        return { kind: 'denied' };
      const db = openDatabase();
      try {
        return run(
          createPairedHomeTransferAuthority({
            database: db,
            security,
            controllerEnvironmentId: controller.environmentId,
          }),
          principal,
        );
      } finally {
        db.close();
      }
    } catch {
      return { kind: 'unavailable' };
    }
  }
  const status = (result: TransferStoreResult<unknown>) =>
    result.kind === 'stored'
      ? 200
      : result.kind === 'denied'
        ? 403
        : result.kind === 'not-found'
          ? 404
          : result.kind === 'conflict'
            ? 409
            : 503;
  async function body(request: Request, keys: string[]) {
    try {
      const bounded = await readBoundedRequestBody(request, 2048);
      if (bounded.status === 'too-large') return 'too-large' as const;
      if (bounded.status !== 'ok') return undefined;
      const value: unknown = JSON.parse(bounded.body);
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(value, key))
      )
        return undefined;
      const data = value as Record<string, unknown>;
      if (
        keys.some((key) =>
          key === 'expectedRevision'
            ? !Number.isSafeInteger(data[key])
            : typeof data[key] !== 'string',
        )
      )
        return undefined;
      return data;
    } catch {
      return undefined;
    }
  }
  app.post('/channels/:channelId/owner', async (c) => {
    c.header('Cache-Control', 'no-store');
    const input = await body(c.req.raw, ['sourceDeviceId', 'policyRevision']);
    if (input === 'too-large') return c.json({ kind: 'invalid-request' }, 413);
    if (!input) return c.json({ kind: 'invalid-request' }, 400);
    const result = await decision(c.req.raw, (authority, principal) =>
      authority.initializeOwner(principal, {
        channelId: c.req.param('channelId'),
        sourceDeviceId: input.sourceDeviceId as string,
        policyRevision: input.policyRevision as string,
      }),
    );
    return c.json(projectDecision(result), status(result));
  });
  app.get('/channels/:channelId', async (c) => {
    c.header('Cache-Control', 'no-store');
    const result = await decision(c.req.raw, (authority, principal) =>
      authority.inspect(principal, c.req.param('channelId')),
    );
    return c.json(projectDecision(result), status(result));
  });
  app.post('/transfers', async (c) => {
    c.header('Cache-Control', 'no-store');
    const input = await body(c.req.raw, [
      'channelId',
      'operationId',
      'targetDeviceId',
      'policyRevision',
      'expectedRevision',
    ]);
    if (input === 'too-large') return c.json({ kind: 'invalid-request' }, 413);
    if (!input) return c.json({ kind: 'invalid-request' }, 400);
    const result = await decision(c.req.raw, (authority, principal) =>
      authority.prepare(principal, {
        channelId: input.channelId as string,
        operationId: input.operationId as string,
        targetDeviceId: input.targetDeviceId as string,
        policyRevision: input.policyRevision as string,
        expectedRevision: input.expectedRevision as number,
      }),
    );
    return c.json(projectDecision(result), status(result));
  });
  app.get('/transfers/:operationId', async (c) => {
    c.header('Cache-Control', 'no-store');
    const result = await decision(c.req.raw, (authority, principal) =>
      authority.resolve(principal, c.req.param('operationId')),
    );
    return c.json(projectDecision(result), status(result));
  });
  return app;
}
