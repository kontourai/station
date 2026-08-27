import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pairingScopePresetString } from '@kontourai/station-contracts/environment-security';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createTaskRoutes } from '../../../routes/orchestration/tasks.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import {
  DevicePairingService,
  type PairingApproval,
} from '../../../services/ssh/device-pairing-service.js';
import {
  type CurrentRuntimeRequestPrincipalSecurity,
  isRuntimeRequestPrincipalCurrent,
} from '../runtime-routes.js';

const homes: string[] = [];
const operatorApproval: PairingApproval = { kind: 'presented-credential' };

function pairOperationCapableDevice() {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-current-principal-'));
  homes.push(homeDir);
  mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
  const pairing = new DevicePairingService({
    homeDir,
    environmentId: '11111111-1111-4111-8111-111111111111',
  });
  const offer = pairing.createOffer({
    endpoint: 'https://station.example.test',
    scope: pairingScopePresetString('standard'),
  });
  const request = pairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'Scoped phone',
  });
  pairing.confirmRequest(request.requestId, operatorApproval);
  return {
    pairing,
    paired: pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
    }),
  };
}

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe('current runtime request principal scope replay', () => {
  test('rejects a queued tool-result keep after the paired device is narrowed without credential rotation', async () => {
    const { pairing, paired } = pairOperationCapableDevice();
    const security: CurrentRuntimeRequestPrincipalSecurity = {
      authorizeCredential: (credential) => pairing.verifyCredential(credential),
      resolveGrantedScope: (credential) =>
        pairing.identifyDevice(credential)?.scope,
    };
    let resolveOwnerRead!: () => void;
    const ownerRead = new Promise<void>((resolve) => {
      resolveOwnerRead = resolve;
    });
    const readToolResult = vi.fn(async () => {
      await ownerRead;
      return {
        status: 'found' as const,
        sessionId: 'session-current',
        eventId: 'event-current',
        result: {
          resultId: 'event-current',
          name: 'shell',
          terminalStatus: 'success' as const,
          content: [],
          truncated: false,
          omittedParts: 0,
          omittedTextBytes: 0,
          omittedMetadataBytes: 0,
        },
      };
    });
    const taskHome = mkdtempSync(
      join(tmpdir(), 'station-current-principal-task-'),
    );
    homes.push(taskHome);
    const taskGraph = new TaskGraphService(taskHome, {
      projectService: {
        getProject: (id) => ({
          id,
          slug: id,
          name: id,
          workingDirectory: taskHome,
          createdAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
        }),
      },
    });
    const task = await taskGraph.createTask({
      projectId: 'project-current',
      title: 'Scope race',
    });
    const app = new Hono();
    app.use('*', async (c, next) => {
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        kind: 'credential',
        credential: paired.credential,
        authority: 'device-credential',
        source: 'bearer',
      });
      await next();
    });
    app.route(
      '/api/tasks',
      createTaskRoutes(taskGraph, {
        taskDispatcher: {
          dispatch: vi.fn(async () => ({
            kind: 'failed' as const,
            reason: 'inert',
          })),
        },
        readAuthorityForRequest: () =>
          sessionReadAuthorityFromRequest(
            'paired-device',
            undefined,
            undefined,
          ),
        canReadSession: () => true,
        readToolResult,
        isRequestPrincipalCurrent: (request) =>
          isRuntimeRequestPrincipalCurrent(request, security),
      }),
    );

    const pending = app.request(`/api/tasks/${task.id}/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'tool-result',
        sessionId: 'session-current',
        eventId: 'event-current',
      }),
    });
    await vi.waitFor(() => expect(readToolResult).toHaveBeenCalledOnce());
    // setDeviceScope keeps this credential valid; only the TaskGraph commit
    // witness's shared guard can observe its operate capability withdrawing.
    pairing.setDeviceScope(
      paired.device.id,
      ['orchestration:read'],
      operatorApproval,
    );
    expect(pairing.verifyCredential(paired.credential)).toBe(true);
    resolveOwnerRead();

    const response = await pending;
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Tool result not found',
    });
    expect(await taskGraph.readTaskToolResultReferenceLinks(task.id)).toEqual(
      [],
    );
  });
});
