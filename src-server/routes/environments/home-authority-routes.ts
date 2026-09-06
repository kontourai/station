import type { DatabaseSync } from 'node:sqlite';
import type {
  HomeControlSessionCapability,
  HomeControlSessionInspectionObservation,
  HomeControlSessionOpenObservation,
  HomeControlSessionRetirementObservation,
  HomeTransferDecisionAdvanceObservation,
  HomeTransferRoomBindingObservation,
  PairedHomeIdentityObservation,
  PersonalHomeDecisionObservation,
} from '@kontourai/station-contracts/cloud-move';
import { Hono } from 'hono';
import { createPersonalRuntimeRequestGuard } from '../../runtime/bootstrap/runtime-tenant-context.js';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { currentHomeTransferDevice } from '../../security/home-transfer-request.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import {
  createHomeTransferRoomBindingService,
  type HomeTransferRoomBindingServiceOptions,
} from '../../services/orchestration/home-transfer-room-binding.js';
import {
  probeHomeTransferRoom,
  readHomeTransferRoomSeal,
} from '../../services/orchestration/home-transfer-room-probe.js';
import { createPairedHomeTransferAuthority } from '../../services/orchestration/paired-home-transfer-authority.js';
import {
  createPlannedHomeControlReplayCapabilityCache,
  createPlannedHomeControlSessionAuthority,
  type PlannedHomeControlResult,
} from '../../services/orchestration/planned-home-control-session-authority.js';
import type {
  PlannedHomeOwner,
  PlannedHomeTransfer,
  TransferStoreResult,
} from '../../services/orchestration/planned-home-transfer-store.js';
import { createRemoteHomeTransferCoordinator } from '../../services/orchestration/remote-home-transfer-coordinator.js';
import type { PeerCredentialStore } from '../../services/peers/peer-credential-store.js';
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
  roomBindings?: {
    peers: Pick<PeerCredentialStore, 'get'>;
    probe?: HomeTransferRoomBindingServiceOptions['probe'];
    readSeal?: typeof readHomeTransferRoomSeal;
  },
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
  const controlReplayCache = createPlannedHomeControlReplayCapabilityCache();
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
  type CurrentPrincipal = NonNullable<
    ReturnType<typeof getRuntimeAuthenticatedRequestPrincipal>
  >;
  type BoundaryFailure = { kind: 'denied' | 'unavailable' };
  async function withPersonalAuthorityDatabase<T extends { kind: string }>(
    request: Request,
    currentPrincipal: (principal: CurrentPrincipal) => boolean,
    run: (
      principal: CurrentPrincipal,
      database: DatabaseSync,
      controllerEnvironmentId: string,
    ) => T | Promise<T>,
  ): Promise<T | BoundaryFailure> {
    const principal = getRuntimeAuthenticatedRequestPrincipal(request);
    if (!principal || !personal(request)) return { kind: 'denied' };
    try {
      const controller = await security.getPublicHandshake();
      const current = () =>
        personal(request) &&
        security.devicePairing.environmentId() === controller.environmentId &&
        currentPrincipal(principal);
      if (!current()) return { kind: 'denied' };
      if (!openDatabase) return { kind: 'unavailable' };
      const database = openDatabase();
      try {
        const result = await run(principal, database, controller.environmentId);
        return current() ? result : { kind: 'denied' };
      } finally {
        database.close();
      }
    } catch {
      return { kind: 'unavailable' };
    }
  }
  async function decision<T>(
    request: Request,
    run: (
      authority: ReturnType<typeof createPairedHomeTransferAuthority>,
      principal: CurrentPrincipal,
      database: DatabaseSync,
      controllerEnvironmentId: string,
    ) => TransferStoreResult<T> | Promise<TransferStoreResult<T>>,
  ): Promise<TransferStoreResult<T>> {
    return withPersonalAuthorityDatabase<TransferStoreResult<T>>(
      request,
      (principal) =>
        principal.authority === 'operator-credential'
          ? security.verifyOperatorCredential(principal.credential)
          : principal.authority === 'device-credential' &&
            typeof principal.deviceId === 'string' &&
            currentHomeTransferDevice(request, security)?.id ===
              principal.deviceId,
      (principal, database, controllerEnvironmentId) =>
        run(
          createPairedHomeTransferAuthority({
            database,
            security,
            controllerEnvironmentId,
          }),
          principal,
          database,
          controllerEnvironmentId,
        ),
    );
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
  const controlStatus = (result: PlannedHomeControlResult<unknown>) =>
    result.kind === 'stored'
      ? 200
      : result.kind === 'denied'
        ? 403
        : result.kind === 'not-found'
          ? 404
          : result.kind === 'unavailable'
            ? 503
            : 409;
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
          key === 'expectedRevision' || key === 'expectedGeneration'
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
  async function controlOpenBody(request: Request) {
    try {
      const bounded = await readBoundedRequestBody(request, 2048);
      if (bounded.status === 'too-large') return 'too-large' as const;
      if (bounded.status !== 'ok') return undefined;
      const value: unknown = JSON.parse(bounded.body);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record);
      if (
        keys.length !== 2 ||
        !Object.hasOwn(record, 'openId') ||
        typeof record.openId !== 'string'
      )
        return undefined;
      if (
        Object.hasOwn(record, 'replaySecret') &&
        keys.every((key) => key === 'openId' || key === 'replaySecret') &&
        typeof record.replaySecret === 'string'
      )
        return { openId: record.openId, replaySecret: record.replaySecret };
      const capability = record.existingCapability;
      if (
        !Object.hasOwn(record, 'existingCapability') ||
        !keys.every(
          (key) => key === 'openId' || key === 'existingCapability',
        ) ||
        !capability ||
        typeof capability !== 'object' ||
        Array.isArray(capability)
      )
        return undefined;
      const candidate = capability as Record<string, unknown>;
      if (
        Object.keys(candidate).length !== 4 ||
        !['homeRef', 'openId', 'generation', 'token'].every((key) =>
          Object.hasOwn(candidate, key),
        ) ||
        typeof candidate.homeRef !== 'string' ||
        typeof candidate.openId !== 'string' ||
        !Number.isSafeInteger(candidate.generation) ||
        typeof candidate.token !== 'string'
      )
        return undefined;
      return {
        openId: record.openId,
        existingCapability: {
          homeRef: candidate.homeRef,
          openId: candidate.openId,
          generation: candidate.generation,
          token: candidate.token,
        } as HomeControlSessionCapability,
      };
    } catch {
      return undefined;
    }
  }

  async function controlDecision<T>(
    request: Request,
    mode: 'participant' | 'operator',
    run: (
      authority: ReturnType<typeof createPlannedHomeControlSessionAuthority>,
      principal: CurrentPrincipal,
    ) => PlannedHomeControlResult<T>,
  ): Promise<PlannedHomeControlResult<T>> {
    return withPersonalAuthorityDatabase<PlannedHomeControlResult<T>>(
      request,
      (principal) =>
        mode === 'operator'
          ? principal.authority === 'operator-credential' &&
            security.verifyOperatorCredential(principal.credential)
          : principal.authority === 'device-credential' &&
            typeof principal.deviceId === 'string' &&
            security.identifyDevice(principal.credential)?.id ===
              principal.deviceId &&
            security.devicePairing.homeControlGrantRevision(
              principal.deviceId,
            ) !== undefined,
      (principal, database, controllerEnvironmentId) =>
        run(
          createPlannedHomeControlSessionAuthority({
            database,
            security,
            controllerEnvironmentId,
            replayCapabilityCache: controlReplayCache,
          }),
          principal,
        ),
    );
  }

  app.post('/control-sessions/open', async (c) => {
    c.header('Cache-Control', 'no-store');
    const input = await controlOpenBody(c.req.raw);
    if (input === 'too-large') return c.json({ kind: 'invalid-request' }, 413);
    if (!input) return c.json({ kind: 'invalid-request' }, 400);
    const result = await controlDecision(
      c.req.raw,
      'participant',
      (authority, principal) => authority.open(principal, input),
    );
    if (result.kind !== 'stored')
      return c.json({ kind: result.kind }, controlStatus(result));
    const observation: HomeControlSessionOpenObservation = {
      schemaVersion: 'station.home-control-session-open/v1',
      capability: result.value.capability,
      replayed: result.value.replayed,
      executionAuthorityTransferred: false,
      executionResumeAvailable: false,
    };
    return c.json(observation, 200);
  });

  app.post('/control-sessions/:deviceId/inspect', async (c) => {
    c.header('Cache-Control', 'no-store');
    const input = await body(c.req.raw, []);
    if (input === 'too-large') return c.json({ kind: 'invalid-request' }, 413);
    if (!input) return c.json({ kind: 'invalid-request' }, 400);
    const result = await controlDecision(
      c.req.raw,
      'operator',
      (authority, principal) =>
        authority.inspect(principal, { deviceId: c.req.param('deviceId') }),
    );
    if (result.kind !== 'stored')
      return c.json({ kind: result.kind }, controlStatus(result));
    const observation: HomeControlSessionInspectionObservation = {
      schemaVersion: 'station.home-control-session-inspection/v1',
      ...result.value,
      executionAuthorityTransferred: false,
      executionResumeAvailable: false,
    };
    return c.json(observation, 200);
  });

  app.post('/control-sessions/:deviceId/retire', async (c) => {
    c.header('Cache-Control', 'no-store');
    const input = await body(c.req.raw, ['expectedGeneration']);
    if (input === 'too-large') return c.json({ kind: 'invalid-request' }, 413);
    if (!input) return c.json({ kind: 'invalid-request' }, 400);
    const result = await controlDecision(
      c.req.raw,
      'operator',
      (authority, principal) =>
        authority.retire(principal, {
          deviceId: c.req.param('deviceId'),
          expectedGeneration: input.expectedGeneration as number,
        }),
    );
    if (result.kind !== 'stored')
      return c.json({ kind: result.kind }, controlStatus(result));
    const observation: HomeControlSessionRetirementObservation = {
      schemaVersion: 'station.home-control-session-retirement/v1',
      ...result.value,
      executionAuthorityTransferred: false,
      executionResumeAvailable: false,
    };
    return c.json(observation, 200);
  });
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
  async function bindingDecision(
    request: Request,
    mode: 'enroll' | 'resolve' | 'inspect',
    input: {
      channelId: string;
      controllerDeviceId: string;
      remoteEnvironmentId?: string;
      remoteTaskId?: string;
    },
  ): Promise<TransferStoreResult<HomeTransferRoomBindingObservation>> {
    return decision(
      request,
      async (_authority, principal, database, controllerEnvironmentId) => {
        if (
          mode !== 'resolve' &&
          !(
            principal.authority === 'operator-credential' &&
            security.verifyOperatorCredential(principal.credential)
          )
        )
          return { kind: 'denied' };
        if (!roomBindings) return { kind: 'unavailable' };
        const service = createHomeTransferRoomBindingService({
          database,
          security,
          controllerEnvironmentId,
          peers: roomBindings.peers,
          probe: roomBindings.probe ?? probeHomeTransferRoom,
        });
        const result =
          mode === 'enroll'
            ? await service.enroll(principal, {
                channelId: input.channelId,
                controllerDeviceId: input.controllerDeviceId,
                remoteEnvironmentId: input.remoteEnvironmentId!,
                remoteTaskId: input.remoteTaskId!,
              })
            : await service.resolve(principal, {
                channelId: input.channelId,
                controllerDeviceId: input.controllerDeviceId,
              });
        if (result.kind !== 'bound') return result;
        const b = result.binding;
        return {
          kind: 'stored',
          value: {
            schemaVersion: 'station.home-transfer-room-binding/v1',
            channelId: b.channelId,
            controllerEnvironmentId: b.controllerEnvironmentId,
            controllerDeviceId: b.controllerDeviceId,
            remoteEnvironmentId: b.remoteEnvironmentId,
            remoteTaskId: b.remoteTaskId,
            remotePairedDeviceId: b.remotePairedDeviceId,
            executionAuthorityTransferred: false,
            executionResumeAvailable: false,
          },
        };
      },
    );
  }
  app.post('/channels/:channelId/bindings', async (c) => {
    c.header('Cache-Control', 'no-store');
    const input = await body(c.req.raw, [
      'controllerDeviceId',
      'remoteEnvironmentId',
      'remoteTaskId',
    ]);
    if (input === 'too-large') return c.json({ kind: 'invalid-request' }, 413);
    if (!input) return c.json({ kind: 'invalid-request' }, 400);
    const result = await bindingDecision(c.req.raw, 'enroll', {
      channelId: c.req.param('channelId'),
      controllerDeviceId: input.controllerDeviceId as string,
      remoteEnvironmentId: input.remoteEnvironmentId as string,
      remoteTaskId: input.remoteTaskId as string,
    });
    return c.json(result, status(result));
  });
  app.post(
    '/channels/:channelId/bindings/:controllerDeviceId/inspect',
    async (c) => {
      c.header('Cache-Control', 'no-store');
      const input = await body(c.req.raw, []);
      if (input === 'too-large')
        return c.json({ kind: 'invalid-request' }, 413);
      if (!input) return c.json({ kind: 'invalid-request' }, 400);
      const result = await bindingDecision(c.req.raw, 'inspect', {
        channelId: c.req.param('channelId'),
        controllerDeviceId: c.req.param('controllerDeviceId'),
      });
      return c.json(result, status(result));
    },
  );
  app.get('/channels/:channelId/binding', async (c) => {
    c.header('Cache-Control', 'no-store');
    const participant = currentHomeTransferDevice(c.req.raw, security);
    if (!participant) return c.json({ kind: 'denied' }, 403);
    const result = await bindingDecision(c.req.raw, 'resolve', {
      channelId: c.req.param('channelId'),
      controllerDeviceId: participant.id,
    });
    return c.json(result, status(result));
  });
  app.post('/transfers/:operationId/advance', async (c) => {
    c.header('Cache-Control', 'no-store');
    const input = await body(c.req.raw, []);
    if (input === 'too-large') return c.json({ kind: 'invalid-request' }, 413);
    if (!input) return c.json({ kind: 'invalid-request' }, 400);
    const result = await decision<HomeTransferDecisionAdvanceObservation>(
      c.req.raw,
      async (_authority, principal, database, controllerEnvironmentId) => {
        if (!roomBindings) return { kind: 'unavailable' };
        const coordinator = createRemoteHomeTransferCoordinator({
          database,
          security,
          controllerEnvironmentId,
          peers: roomBindings.peers,
          probe: roomBindings.probe,
          readSeal: roomBindings.readSeal,
        });
        const advanced = await coordinator.advance(
          principal,
          c.req.param('operationId'),
        );
        if (
          advanced.kind !== 'pending' &&
          advanced.kind !== 'decision-committed'
        )
          return { kind: advanced.kind };
        const projected = projectDecision({
          kind: 'stored',
          value: advanced.decision,
        });
        if (
          projected.kind !== 'stored' ||
          projected.value.kind !== 'transfer-decision'
        )
          return { kind: 'unavailable' };
        const common = {
          schemaVersion: 'station.home-transfer-decision-advance/v1' as const,
          decision: projected.value,
          executionAuthorityTransferred: false as const,
          executionResumeAvailable: false as const,
        };
        return {
          kind: 'stored',
          value:
            advanced.kind === 'pending'
              ? { ...common, outcome: 'pending', reason: advanced.reason }
              : { ...common, outcome: 'decision-committed' },
        };
      },
    );
    return c.json(
      result,
      result.kind === 'stored' && result.value.outcome === 'pending'
        ? 202
        : status(result),
    );
  });
  return app;
}
