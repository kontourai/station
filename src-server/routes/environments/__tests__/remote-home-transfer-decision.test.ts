import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ProjectTaskRoomGrant,
  ProjectTaskRoomGrantKind,
} from '@kontourai/station-contracts/project-task-room';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { createPersonalHomeAuthorityDatabase } from '../../../runtime/bootstrap/personal-home-authority-database.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import {
  probeHomeTransferRoom,
  readHomeTransferRoomSeal,
} from '../../../services/orchestration/home-transfer-room-probe.js';
import { projectTaskRoomChannelId } from '../../../services/orchestration/project-task-room-history.js';
import { ProjectTaskRoomRuntime } from '../../../services/orchestration/project-task-room-runtime.js';
import { PeerCredentialStore } from '../../../services/peers/peer-credential-store.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { createLogger } from '../../../utils/logger.js';
import { createHomeAuthorityRoutes } from '../home-authority-routes.js';
import { createHomeTransferRoomRoutes } from '../home-transfer-room-routes.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), name));
  roots.push(root);
  return root;
}

function configureAuthenticatedApp(security: EnvironmentSecurityService): Hono {
  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: createLogger({ name: 'remote-home-transfer-test', level: 'error' }),
    eventBus: { emit() {} } as unknown as EventBus,
    security: {
      verifyCredential: (candidate, request) =>
        request !== undefined &&
        security.authorizeCredential(candidate, request),
      resolveGrantedScope: (candidate) =>
        security.resolveGrantedScope(candidate),
      resolveCredentialAuthority: (candidate) =>
        security.verifyOperatorCredential(candidate)
          ? 'operator-credential'
          : 'device-credential',
      resolveCredentialDeviceId: (candidate) =>
        security.identifyDevice(candidate)?.id,
      allowedOrigins: [],
    },
  });
  return app;
}

function pair(
  security: EnvironmentSecurityService,
  endpoint: string,
  name: string,
) {
  const offer = security.devicePairing.createOffer({
    endpoint,
    scope: 'home:transfer',
  });
  const request = security.devicePairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: name,
  });
  security.devicePairing.confirmRequest(request.requestId, {
    kind: 'presented-credential',
  });
  return security.devicePairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: request.requestId,
  });
}

function grant<K extends ProjectTaskRoomGrantKind>(
  capability: K,
): ProjectTaskRoomGrant<K> {
  return Object.freeze({
    schemaVersion: 'station.project-task-room-grant/v1',
    capability,
    opaqueToken: `fixture-operator-${capability}`,
  }) as ProjectTaskRoomGrant<K>;
}

async function createRemoteHome(
  origin: string,
  projectId: string,
  taskId: string,
) {
  const root = temporaryRoot('station-remote-home-');
  const security = new EnvironmentSecurityService({ homeDir: root });
  const identity = await security.initialize();
  const graph = new TaskGraphService(root, {
    projectService: {
      getProject: (slug) => ({
        id: slug,
        slug,
        name: slug,
        workingDirectory: root,
        createdAt: '2026-09-06T00:00:00.000Z',
        updatedAt: '2026-09-06T00:00:00.000Z',
      }),
    },
  });
  const task = await graph.createTask(
    { projectId, title: 'Remote transfer room' },
    undefined,
    taskId,
  );
  const databasePath = join(root, 'orchestration.sqlite');
  const scope = {
    projectId: task.projectId,
    projectSlug: projectId,
    taskId: task.id,
  };
  let store: EventStore;
  let runtime: ProjectTaskRoomRuntime;
  let open = false;

  const compose = () => {
    store = new EventStore(databasePath);
    runtime = new ProjectTaskRoomRuntime({
      taskGraph: graph,
      projectForId: (id) =>
        id === projectId ? { id, slug: projectId } : undefined,
      history: (authority) =>
        store.createProjectTaskRoomHistory({
          capabilities: authority.capabilities,
          agents: authority.agents,
        }),
      working: store.createProjectTaskRoomWorkingState(),
      requestAuthority: {
        resolve: async (request) => {
          const principal = getRuntimeAuthenticatedRequestPrincipal(request);
          if (principal?.authority !== 'device-credential')
            return { kind: 'revoked' as const };
          const device = security.identifyDevice(principal.credential);
          return device
            ? {
                kind: 'granted' as const,
                operatorId: `paired:${device.id}`,
                deviceId: device.id,
                policyRevision: device.scope,
              }
            : { kind: 'revoked' as const };
        },
      },
    });
    open = true;
  };
  compose();

  // These Hono apps model separately persisted HTTP owners in one test
  // process. They are not independent Station hosts and run no cloud or Agent.
  const app = configureAuthenticatedApp(security);
  app.route(
    '/api/home-authority/rooms',
    createHomeTransferRoomRoutes({
      security,
      roomRuntime: {
        inspectTransferRoom: (input) => runtime.inspectTransferRoom(input),
        readTransferSourceSeal: (input) =>
          runtime.readTransferSourceSeal(input),
      },
    }),
  );

  const operatorHistory = () =>
    store.createProjectTaskRoomHistory({
      capabilities: {
        resolve: async ({ grant: presented, required }) =>
          presented.opaqueToken === `fixture-operator-${required}` &&
          presented.capability === required
            ? {
                kind: 'granted' as const,
                receipt: {
                  receiptId: `fixture-operator-${required}`,
                  capability: required,
                  scope,
                  principal: {
                    kind: 'operator' as const,
                    operatorId: 'fixture-operator',
                    deviceId: 'fixture-device',
                  },
                  policyRevision: 'fixture-policy-v1',
                },
              }
            : { kind: 'denied' as const },
      },
    });

  return {
    origin,
    app,
    security,
    identity,
    task,
    scope,
    databasePath,
    operatorHistory,
    async closeStorage() {
      if (!open) return;
      await runtime.close();
      expect(store.close()).toEqual({ kind: 'closed' });
      open = false;
    },
    reopenStorage() {
      if (open) throw new Error('Remote storage is already open');
      compose();
    },
  };
}

test.skipIf(process.platform === 'win32')(
  'commits a remote home decision over paired HTTP only after a copied durable source seal',
  async () => {
    vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', undefined);
    const projectId = 'transfer-project';
    const taskId = '33333333-3333-4333-8333-333333333333';
    const source = await createRemoteHome(
      'https://source.example.test',
      projectId,
      taskId,
    );
    const target = await createRemoteHome(
      'https://target.example.test',
      projectId,
      taskId,
    );
    const controllerRoot = temporaryRoot('station-transfer-controller-');
    const controllerSecurity = new EnvironmentSecurityService({
      homeDir: controllerRoot,
    });
    const controllerIdentity = await controllerSecurity.initialize();
    const sourceParticipant = pair(
      controllerSecurity,
      'https://controller.example.test',
      'Source participant',
    );
    const targetParticipant = pair(
      controllerSecurity,
      'https://controller.example.test',
      'Target participant',
    );
    const controllerAtSource = pair(
      source.security,
      source.origin,
      'Transfer controller',
    );
    const controllerAtTarget = pair(
      target.security,
      target.origin,
      'Transfer controller',
    );
    const peers = new PeerCredentialStore(controllerRoot);
    await peers.upsert({
      environmentId: source.identity.environmentId,
      apiBase: source.origin,
      scope: 'home:transfer',
      credential: controllerAtSource.credential,
    });
    await peers.upsert({
      environmentId: target.identity.environmentId,
      apiBase: target.origin,
      scope: 'home:transfer',
      credential: controllerAtTarget.credential,
    });

    let tamperTargetSealNonce = false;
    const fetchRemote: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === source.origin) return source.app.fetch(request);
      if (url.origin !== target.origin)
        throw new Error(`Unexpected transfer origin: ${url.origin}`);
      const response = await target.app.fetch(request);
      if (!tamperTargetSealNonce || !url.pathname.endsWith('/seal-observation'))
        return response;
      const observation = (await response.json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ ...observation, nonce: 'forged-target-nonce' }),
        { status: response.status, headers: response.headers },
      );
    };
    const authorityDirectory = temporaryRoot('station-transfer-authority-');
    const openAuthorityDatabase = createPersonalHomeAuthorityDatabase(
      controllerRoot,
      join(authorityDirectory, 'authority.sqlite'),
    );
    const controllerApp = configureAuthenticatedApp(controllerSecurity);
    controllerApp.route(
      '/api/home-authority',
      createHomeAuthorityRoutes(controllerSecurity, openAuthorityDatabase, {
        peers,
        probe: (peer, input) => probeHomeTransferRoom(peer, input, fetchRemote),
        readSeal: (peer, input) =>
          readHomeTransferRoomSeal(peer, input, fetchRemote),
      }),
    );
    const post = (path: string, credential: string, body: unknown) =>
      controllerApp.request(`/api/home-authority${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

    let sourceOpen = true;
    let targetOpen = true;
    try {
      const sourceHistory = source.operatorHistory();
      const targetHistory = target.operatorHistory();
      const sourceRoom = await sourceHistory.open({ grant: grant('discover') });
      const targetRoom = await targetHistory.open({ grant: grant('discover') });
      expect(sourceRoom).toMatchObject({ kind: 'opened' });
      expect(targetRoom).toMatchObject({ kind: 'opened' });
      const channelId = projectTaskRoomChannelId(source.scope);
      expect(projectTaskRoomChannelId(target.scope)).toBe(channelId);

      for (const binding of [
        {
          controllerDeviceId: sourceParticipant.device.id,
          remoteEnvironmentId: source.identity.environmentId,
          remoteTaskId: source.task.id,
        },
        {
          controllerDeviceId: targetParticipant.device.id,
          remoteEnvironmentId: target.identity.environmentId,
          remoteTaskId: target.task.id,
        },
      ]) {
        const enrolled = await post(
          `/channels/${channelId}/bindings`,
          controllerIdentity.credential,
          binding,
        );
        expect(enrolled.status).toBe(200);
      }

      const owner = await post(
        `/channels/${channelId}/owner`,
        controllerIdentity.credential,
        {
          sourceDeviceId: sourceParticipant.device.id,
          policyRevision: 'fixture-policy-v1',
        },
      );
      expect(owner.status).toBe(200);
      const operationId = 'remote-fixture-transfer';
      const prepared = await post('/transfers', sourceParticipant.credential, {
        channelId,
        operationId,
        targetDeviceId: targetParticipant.device.id,
        policyRevision: 'fixture-policy-v1',
        expectedRevision: 0,
      });
      expect(prepared.status).toBe(200);

      const wrongCaller = await post(
        `/transfers/${operationId}/advance`,
        targetParticipant.credential,
        {},
      );
      expect(wrongCaller.status).toBe(403);
      expect(await wrongCaller.json()).toEqual({ kind: 'denied' });

      const firstAdvance = await post(
        `/transfers/${operationId}/advance`,
        sourceParticipant.credential,
        {},
      );
      expect(firstAdvance.status).toBe(202);
      expect(await firstAdvance.json()).toMatchObject({
        kind: 'stored',
        value: {
          schemaVersion: 'station.home-transfer-decision-advance/v1',
          outcome: 'pending',
          reason: 'source-not-closed',
          decision: {
            kind: 'transfer-decision',
            operationId,
            phase: 'prepared',
            executionAuthorityTransferred: false,
            executionResumeAvailable: false,
          },
          executionAuthorityTransferred: false,
          executionResumeAvailable: false,
        },
      });
      expect(
        await sourceHistory.readSourceSeal({ grant: grant('history-read') }),
      ).toEqual({ kind: 'unsealed' });
      expect(
        await targetHistory.readSourceSeal({ grant: grant('history-read') }),
      ).toEqual({ kind: 'unsealed' });

      const sourceHomeRef = `paired:${sourceParticipant.device.id}`;
      const targetHomeRef = `paired:${targetParticipant.device.id}`;
      // This explicit local operator action is the fixture's only seal
      // mutation. Both controller advances remain read-only remote probes.
      const sealed = await sourceHistory.sealSource({
        grant: grant('home-transfer'),
        operationId,
        sourceHomeRef,
        targetHomeRef,
      });
      expect(sealed).toMatchObject({ kind: 'sealed' });
      await sourceHistory.close();
      await targetHistory.close();
      await source.closeStorage();
      sourceOpen = false;
      await target.closeStorage();
      targetOpen = false;
      copyFileSync(source.databasePath, target.databasePath);
      source.reopenStorage();
      sourceOpen = true;
      target.reopenStorage();
      targetOpen = true;

      tamperTargetSealNonce = true;
      const forgedTargetObservation = await post(
        `/transfers/${operationId}/advance`,
        sourceParticipant.credential,
        {},
      );
      expect(forgedTargetObservation.status).toBe(409);
      expect(await forgedTargetObservation.json()).toEqual({
        kind: 'conflict',
      });
      const ownerAfterConflict = await controllerApp.request(
        `/api/home-authority/channels/${channelId}`,
        {
          headers: {
            Authorization: `Bearer ${sourceParticipant.credential}`,
          },
        },
      );
      expect(ownerAfterConflict.status).toBe(200);
      expect(await ownerAfterConflict.json()).toMatchObject({
        kind: 'stored',
        value: {
          kind: 'owner-binding',
          channelId,
          homeRef: sourceHomeRef,
          revision: 0,
        },
      });

      tamperTargetSealNonce = false;
      const committed = await post(
        `/transfers/${operationId}/advance`,
        sourceParticipant.credential,
        {},
      );
      expect(committed.status).toBe(200);
      const committedBody = await committed.json();
      expect(committedBody).toMatchObject({
        kind: 'stored',
        value: {
          schemaVersion: 'station.home-transfer-decision-advance/v1',
          outcome: 'decision-committed',
          decision: {
            kind: 'transfer-decision',
            operationId,
            sourceHomeRef,
            targetHomeRef,
            phase: 'committed',
            executionAuthorityTransferred: false,
            executionResumeAvailable: false,
          },
          executionAuthorityTransferred: false,
          executionResumeAvailable: false,
        },
      });
      const repeated = await post(
        `/transfers/${operationId}/advance`,
        sourceParticipant.credential,
        {},
      );
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toEqual(committedBody);

      const reopenedSource = source.operatorHistory();
      const reopenedTarget = target.operatorHistory();
      expect(
        await reopenedTarget.readSourceSeal({ grant: grant('history-read') }),
      ).toEqual(sealed);
      expect(
        await reopenedSource.append({
          grant: grant('message-write'),
          intent: {
            proposalId: 'write-after-seal',
            occurredAt: '2026-09-06T00:01:00.000Z',
            body: { kind: 'human-message', text: 'must remain sealed' },
          },
        }),
      ).toEqual({ kind: 'denied' });
      await reopenedSource.close();
      await reopenedTarget.close();
    } finally {
      if (sourceOpen) await source.closeStorage();
      if (targetOpen) await target.closeStorage();
    }
  },
);
