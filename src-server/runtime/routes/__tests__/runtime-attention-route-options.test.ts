import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AttentionProjection,
  ReviewPendingAttentionItem,
} from '@kontourai/station-contracts/attention';
import {
  PAIRING_SCOPE_ORCHESTRATION_OPERATE,
  PAIRING_SCOPE_ORCHESTRATION_READ,
} from '@kontourai/station-contracts/environment-security';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, expect, test } from 'vitest';
import { createAttentionRoutes } from '../../../routes/orchestration/attention.js';
import {
  type RuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { AttentionProjectionService } from '../../../services/projects/attention-projection.js';
import { runtimeAttentionRouteOptions } from '../runtime-attention-route-options.js';

/**
 * The runtime's `/api/attention` composition decides whether a paired-Station
 * item offers Allow/Deny (`viewerCanRespond`). Driven through the real
 * `createAttentionRoutes` + `runtimeAttentionRouteOptions` + projection over a
 * real peer record whose paired Station reported an open approval, with the
 * request principal set the way the HTTP boundary sets it.
 */
const OPERATOR = 'operator-secret';
const OPERATE_DEVICE = 'operate-device';
const READ_DEVICE = 'read-device';

const security = {
  authorizeCredential: () => true,
  verifyOperatorCredential: (credential: string) => credential === OPERATOR,
  credentialMayDecidePairingRequests: () => false,
  resolveGrantedScope: (credential: string) =>
    credential === READ_DEVICE
      ? PAIRING_SCOPE_ORCHESTRATION_READ
      : `${PAIRING_SCOPE_ORCHESTRATION_READ} ${PAIRING_SCOPE_ORCHESTRATION_OPERATE}`,
};

function principalFor(
  credential: string,
): RuntimeAuthenticatedRequestPrincipal {
  return credential === OPERATOR
    ? {
        kind: 'credential',
        credential,
        authority: 'operator-credential',
        source: 'bearer',
      }
    : {
        kind: 'credential',
        credential,
        authority: 'device-credential',
        deviceId: `device-${credential}`,
        deviceKind: 'device',
        source: 'bearer',
      };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function projectionWithPeerApproval(
  requestType: 'approval' | 'input' = 'approval',
) {
  const home = mkdtempSync(join(tmpdir(), 'station-attention-options-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new EventStore(join(home, 'orchestration.sqlite'));
  cleanups.push(() => {
    store.close();
  });
  const service = new OrchestrationService({
    eventStore: store,
    adoptionLedger: store.createAdoptionLedger(),
    eventBus: new EventBus(),
    adapterRegistry: {
      register() {},
      get: (provider: string) =>
        provider === 'station-agent' ? ({ provider } as never) : undefined,
      list: () => [],
    } as never,
    logger: { debug() {}, warn() {} },
  });
  cleanups.push(() => {
    service.shutdown();
  });
  service.recordPeerDelegationActivityDispatch({
    taskId: 'task-peer',
    conversationId: 'task-peer',
    prompt: 'Run it there',
    userId: 'default',
    environment: { id: 'environment-peer', name: 'Station B', kind: 'peer' },
    target: { kind: 'agent', id: 'codex' },
  });
  service.recordPeerDelegationActivityOutcome({
    taskId: 'task-peer',
    environmentId: 'environment-peer',
    status: requestType === 'input' ? 'needs_input' : 'review_pending',
  });
  service.recordPeerDelegationPendingRequest({
    taskId: 'task-peer',
    environmentId: 'environment-peer',
    pendingRequest: { id: 'req-1', type: requestType, title: 'Allow bash' },
  });
  return new AttentionProjectionService({ list: () => [] } as never, service, {
    getRunConsole: async () => ({ gates: [] }),
  } as never);
}

async function peerItemAs(
  credential: string,
  options: Parameters<typeof createAttentionRoutes>[1] | 'runtime' = 'runtime',
  requestType: 'approval' | 'input' = 'approval',
): Promise<ReviewPendingAttentionItem | undefined> {
  const projection = projectionWithPeerApproval(requestType);
  const app = new Hono();
  app.use('*', async (c, next) => {
    setRuntimeAuthenticatedRequestPrincipal(
      c.req.raw,
      principalFor(credential),
    );
    await next();
  });
  app.route(
    '/api/attention',
    createAttentionRoutes(
      projection,
      options === 'runtime'
        ? runtimeAttentionRouteOptions({
            readAuthorityForRequest: () =>
              sessionReadAuthorityFromRequest('default', undefined, undefined),
            resolvePrincipal: () => ({ id: LOCAL_OPERATOR_PRINCIPAL_ID }),
            security,
            stationControlDispatchScope: undefined,
          })
        : options,
    ),
  );
  const response = await app.request('/api/attention');
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: AttentionProjection };
  return body.data.items.find(
    (item): item is ReviewPendingAttentionItem =>
      (item.kind === 'review_pending' || item.kind === 'needs_input') &&
      item.environmentKind === 'peer',
  ) as ReviewPendingAttentionItem | undefined;
}

test('the operator, whose credential can POST the respond route, may respond', async () => {
  expect(await peerItemAs(OPERATOR)).toMatchObject({
    peerRequestReference: { requestId: 'req-1' },
    viewerCanRespond: true,
  });
});

test('a device granted orchestration operate may respond', async () => {
  expect((await peerItemAs(OPERATE_DEVICE))?.viewerCanRespond).toBe(true);
});

test('a device whose pairing scope cannot POST /respond may not', async () => {
  expect((await peerItemAs(READ_DEVICE))?.viewerCanRespond).toBe(false);
});

test('a route composed without the predicate claims nothing', async () => {
  const item = await peerItemAs(OPERATOR, {
    readAuthorityForRequest: () =>
      sessionReadAuthorityFromRequest('default', undefined, undefined),
  });
  expect(item).toHaveProperty('peerRequestReference');
  expect(item).not.toHaveProperty('viewerCanRespond');
});

test('an input question is judged on the continue route: operate may answer, read may not', async () => {
  expect(
    (await peerItemAs(OPERATE_DEVICE, 'runtime', 'input'))?.viewerCanRespond,
  ).toBe(true);
  expect(
    (await peerItemAs(READ_DEVICE, 'runtime', 'input'))?.viewerCanRespond,
  ).toBe(false);
});
