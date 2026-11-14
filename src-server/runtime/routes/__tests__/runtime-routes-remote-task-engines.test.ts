/**
 * The remote task engine routes as `configureRuntimeRoutes` composes them,
 * behind the real runtime auth boundary: the `remote-task-engines` preview
 * the runtime binds gates them, and the runtime's own managed policy reaches
 * the service. A composition that passed no policy, or bound another preview
 * id, would fail here even though the route suites pass.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import {
  type ManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { __resetStationServerSelfAttestationForTests } from '../../../security/station-server-scope.js';
import { FeaturePreviewRegistry } from '../../../services/feature-previews/feature-preview-registry.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

vi.mock('../runtime-route-support.js', () => {
  const stub = new Proxy({}, { get: () => () => undefined });
  return {
    configureRuntimeSupportServices: () => ({
      schedulerService: stub,
      notificationService: stub,
      attentionProjection: stub,
      webPushService: stub,
      webPushEnabled: false,
    }),
    createRuntimeSystemRouteDeps: () => stub,
  };
});

function deepStub<T extends object>(overrides: T): T {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      const proxy: unknown = new Proxy(() => undefined, {
        get: (_target, property) => (property === 'then' ? undefined : proxy),
      });
      return proxy;
    },
  }) as T;
}

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-remote-tasks';
/**
 * The composed runtime keeps files open in its home until the process ends,
 * which Windows refuses to delete, so removal here is best effort.
 */
function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function managed(document: ManagedPolicyDocument) {
  return { document, summary: summarizeManagedPolicy(document) };
}

describe('configureRuntimeRoutes: remote task engines', () => {
  const closers: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function setup(policy: ReturnType<typeof managed> | null) {
    const homeDir = makeTempDir('station-remote-task-routes-');
    closers.push(() => {
      try {
        rmSync(homeDir, { recursive: true, force: true });
      } catch {
        // Left for the OS temp cleanup; see makeTempDir.
      }
    });
    __resetStationServerSelfAttestationForTests();
    const registry = new FeaturePreviewRegistry(homeDir, {
      debug() {},
      info() {},
      warn() {},
      error() {},
    } as never);
    const app = new Hono();
    const overrides = {
      projectSharedTasks: undefined,
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      managedPolicy: policy,
      app,
      port: 4321,
      appConfig: {},
      featurePreviews: registry,
      configLoader: {
        getProjectHomeDir: () => homeDir,
        loadAppConfig: () => ({}),
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      activeAgents: new Map(),
      agentService: { listAgents: () => [] },
      agentMetadataMap: new Map(),
      agentFixedTokens: new Map(),
      agentTools: new Map(),
      agentStats: new Map(),
      agentStatus: new Map(),
      memoryAdapters: new Map(),
      metricsLog: [],
      monitoringEvents: [],
      // Inert orchestration: these routes never reach it.
      orchestrationEventStore: deepStub({
        sessionTurnBoundaryAuthority: () => ({
          reconcile: () => ({ kind: 'available', interrupted: [] }),
          hasPossibleEffect: () => ({ kind: 'available', active: false }),
        }),
        conversationSessions: () => [],
        readSessionByThread: () => undefined,
      }),
      orchestrationService: deepStub({
        canUserReadSession: () => true,
        canUserReadConversation: () => true,
        firstStartedMetadataOfThread: () => undefined,
      }),
      storageAdapter: deepStub({
        getProject: () => {
          throw new Error('no project');
        },
      }),
      projectMembership: deepStub({ admissionsForResolvedPrincipal: () => [] }),
      taskGraphService: { listTasks: () => [] },
      projectService: { listProjects: () => [] },
      environmentSecurityService: deepStub({
        verifyCredential: (credential: string) =>
          credential === OPERATOR_CREDENTIAL,
        authorizeCredential: (credential: string) =>
          credential === OPERATOR_CREDENTIAL,
        verifyOperatorCredential: (credential: string) =>
          credential === OPERATOR_CREDENTIAL,
        resolveGrantedScope: (credential: string) =>
          credential === OPERATOR_CREDENTIAL
            ? 'orchestration:read orchestration:operate'
            : undefined,
        identifyDevice: () => undefined,
        devicePairing: deepStub({}),
      }),
    };
    const context = deepStub(overrides);
    Reflect.set(context as object, 'buildRuntimeContext', () => context);
    const result = configureRuntimeRoutes(
      context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
    );
    await result.kitLifecycleReady;
    let resolvePort!: (port: number) => void;
    const listening = new Promise<number>((resolve) => {
      resolvePort = resolve;
    });
    const server = serve(
      { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
      (info) => resolvePort((info as AddressInfo).port),
    );
    closers.unshift(
      () =>
        new Promise<void>((resolve) => {
          (
            server as unknown as { closeAllConnections?: () => void }
          ).closeAllConnections?.();
          server.close(() => resolve());
        }),
    );
    const base = `http://127.0.0.1:${await listening}`;
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
          'content-type': 'application/json',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    return { call, registry };
  }

  test('the routes are gated by the preview the runtime binds', async () => {
    const { call, registry } = await setup(null);
    const off = await call('GET', '/remote-task-engines/connections');
    expect(off.status).toBe(404);
    expect(await off.json()).toMatchObject({
      code: 'feature_preview_disabled',
      previewId: 'remote-task-engines',
    });
    await registry.setEnabled('remote-task-engines', true);
    const on = await call('GET', '/remote-task-engines/connections');
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ success: true, data: [] });
  });

  test("the runtime's managed policy reaches the service", async () => {
    const { call, registry } = await setup(
      managed({
        schemaVersion: 1,
        organization: 'Example Corp',
        limits: { engines: { remoteTasks: ['cursor'] } },
      }),
    );
    await registry.setEnabled('remote-task-engines', true);
    const refused = await call('POST', '/remote-task-engines/connections', {
      vendor: 'devin',
      settings: { orgId: 'org-abc123def456' },
    });
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as { code: string; error: string };
    expect(body.code).toBe('remote-task-policy-refused');
    expect(body.error).toContain('Example Corp');
    // The vendor the policy names is allowed.
    const allowed = await call('POST', '/remote-task-engines/connections', {
      vendor: 'cursor',
    });
    expect(allowed.status).toBe(201);
  });
});
