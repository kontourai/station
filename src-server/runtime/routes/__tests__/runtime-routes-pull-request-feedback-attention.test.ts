/**
 * Pull request feedback in Needs you, through the production composition:
 * `configureRuntimeRoutes` with the real `configureRuntimeSupportServices`
 * (its NotificationService and AttentionProjectionService), the real
 * `/api/attention` routes with `runtimeAttentionRouteOptions`, the real
 * request-authority middleware, and the real feedback store and inbox.
 *
 * A pause reached through delivery must leave both a Needs-you item and one
 * notification record, the item must say whether this caller may change it,
 * and the notification must settle once the pause is lifted. Only the
 * credential checks are stand-ins: a temp home has no paired devices.
 */

import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { pullRequestFeedbackKey } from '@kontourai/station-contracts/pull-request-feedback';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { __resetStationServerSelfAttestationForTests } from '../../../security/station-server-scope.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import { ConversationPullRequestLinkStore } from '../../../services/pull-requests/conversation-pull-request-link-store.js';
import {
  PullRequestFeedbackStore,
  pullRequestFeedbackStorePath,
} from '../../../services/pull-requests/pull-request-feedback-store.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

/** Answers every unlisted member with an inert, non-thenable proxy. */
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

const OPERATOR = 'test-only-operator-credential-pr-feedback-attention';
/** The operator credential, revoked while its request is being answered. */
const REVOKED = 'test-only-revoked-operator-credential';
const CHAT = 'chat-pr-feedback';
const OTHERS_CHAT = 'chat-someone-else';
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const PR = {
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'acme', name: 'widgets' },
  ref: '42',
};
const makeTempDir = trackTempDirs();

describe('pull request feedback reaches Needs you through the production composition', () => {
  const closers: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function setup() {
    const homeDir = makeTempDir('station-pr-feedback-attention-');
    __resetStationServerSelfAttestationForTests();
    const bus = new EventBus();
    const store = new EventStore(join(homeDir, 'orchestration.sqlite'));
    closers.push(async () => {
      await store.close();
    });
    const orchestration = new OrchestrationService({
      adapterRegistry: {
        register() {},
        get: () => undefined,
        list: () => [],
      } as never,
      eventBus: bus,
      eventStore: store,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } as never,
    });
    closers.unshift(async () => {
      await orchestration.shutdown();
    });
    // The revoked credential passes ingress, then is revoked before the
    // projection asks who may change the item: Station must not offer it.
    const revocation = { revoked: false };
    const listSessions = orchestration.listSessionReadModel.bind(orchestration);
    orchestration.listSessionReadModel = ((...args: never[]) => {
      revocation.revoked = true;
      return (listSessions as (...a: never[]) => unknown)(...args);
    }) as typeof orchestration.listSessionReadModel;
    const authorized = (credential: string) =>
      credential === OPERATOR ||
      (credential === REVOKED && !revocation.revoked);

    const projectService = {
      listProjects: () => [],
      getProject: () => {
        throw new Error('no project');
      },
    };
    const app = new Hono();
    let resolvePort!: (port: number) => void;
    const listening = new Promise<number>((resolve) => {
      resolvePort = resolve;
    });
    const server = serve(
      { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
      (info) => resolvePort((info as AddressInfo).port),
    );
    closers.unshift(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const port = await listening;
    const context = deepStub({
      featurePreviews: {
        bind: (definition: { id: string }) => ({
          select: <T>(branches: { enabled: () => T; disabled: () => T }) =>
            definition.id === 'pull-request-agent-feedback'
              ? branches.enabled()
              : branches.disabled(),
        }),
      },
      projectSharedTasks: undefined,
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      app,
      port,
      appConfig: {},
      eventBus: bus,
      configLoader: {
        getProjectHomeDir: () => homeDir,
        loadAppConfig: () => ({}),
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      activeAgents: new Map(),
      agentService: { listAgents: async () => [], findAgent: async () => null },
      agentMetadataMap: new Map(),
      agentFixedTokens: new Map(),
      agentTools: new Map(),
      agentStats: new Map(),
      agentStatus: new Map(),
      memoryAdapters: new Map(),
      metricsLog: [],
      monitoringEvents: [],
      orchestrationEventStore: store,
      orchestrationService: orchestration,
      projectMembership: undefined,
      projectService,
      taskGraphService: new TaskGraphService(homeDir, {
        projectService: projectService as never,
      }),
      storageAdapter: deepStub({}),
      proposedChangeService: deepStub({ list: () => [] }),
      environmentSecurityService: deepStub({
        verifyCredential: authorized,
        authorizeCredential: authorized,
        verifyOperatorCredential: (credential: string) =>
          credential === OPERATOR || credential === REVOKED,
        resolveGrantedScope: (credential: string) =>
          authorized(credential)
            ? 'orchestration:read orchestration:operate access:manage'
            : undefined,
        identifyDevice: () => undefined,
        credentialMayDecidePairingRequests: () => false,
        devicePairing: deepStub({
          listRequests: () => [],
          listDevices: () => [],
          environmentId: () => 'environment-test',
        }),
      }),
    });
    Reflect.set(context as object, 'buildRuntimeContext', () => context);
    const configured = configureRuntimeRoutes(
      context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
    );
    closers.unshift(async () => {
      configured.schedulerService?.stop?.();
      configured.notificationService?.shutdown?.();
    });
    await configured.kitLifecycleReady;
    const base = `http://127.0.0.1:${port}`;
    const as = async (
      credential: string,
      method: string,
      path: string,
      body?: unknown,
    ) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${credential}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, json: (await response.json()) as any };
    };

    for (const [threadId, owner] of [
      [CHAT, LOCAL_OPERATOR_PRINCIPAL_ID],
      [OTHERS_CHAT, 'someone-else'],
    ] as const)
      orchestration.seedSessionRecord({
        threadId,
        provider: 'task-dispatch',
        status: 'ready',
        ownerUserId: owner,
      } as never);

    /** A claim on CHAT's linked pull request, three rounds spent on HEAD. */
    const pausedOnDelivery = async (conversationId = CHAT) => {
      const links = new ConversationPullRequestLinkStore(homeDir);
      await links.link(
        conversationId,
        PR,
        LOCAL_OPERATOR_PRINCIPAL_ID,
        () => true,
      );
      const feedback = new PullRequestFeedbackStore(
        pullRequestFeedbackStorePath(homeDir),
      );
      closers.push(() => feedback.close());
      const prKey = pullRequestFeedbackKey(PR);
      const at = new Date().toISOString();
      feedback.writeClaim({
        prKey,
        identity: PR,
        conversationId,
        settings: {
          fixFailingChecks: true,
          addressReviewComments: false,
          reviewEachHead: false,
        },
        enabledBy: LOCAL_OPERATOR_PRINCIPAL_ID,
        now: at,
      });
      // Not due: the test never reads GitHub.
      feedback.setNextDueAt(prKey, Date.now() + 86_400_000);
      feedback.writeObservation(prKey, {
        observation: {
          identity: PR,
          url: 'https://github.com/acme/widgets/pull/42',
          state: 'OPEN',
          draft: false,
          headSha: HEAD,
          baseSha: 'b'.repeat(40),
          headRefName: 'feature',
          baseRefName: 'main',
          mergeable: 'mergeable',
          checks: [
            {
              name: 'ci / unit-tests',
              conclusion: 'FAILURE',
              completed: true,
              required: true,
            },
          ],
          checksTruncated: false,
          threads: [],
          threadsTotal: 0,
          reviews: [],
          observedAt: at,
        },
        observedAt: at,
        unchangedSince: at,
        digest: 'd',
      });
      for (const n of [1, 2, 3]) {
        feedback.beginBatch(
          {
            key: `prf-round-${n}`,
            conversationId,
            generation: 1,
            state: 'submitting',
            message: 'm',
            actor: { userId: LOCAL_OPERATOR_PRINCIPAL_ID },
            createdAt: at,
            summary: [{ prKey, headSha: HEAD, generation: 1, categories: [] }],
          },
          [],
        );
        feedback.settleBatch(`prf-round-${n}`, 'sent', at);
      }
      // The agent's own event wakes delivery, as in production.
      bus.emit('orchestration:event', {
        event: {
          threadId: conversationId,
          method: 'turn.started',
          provider: 'task-dispatch',
          createdAt: at,
        },
      });
      await vi.waitFor(() =>
        expect(feedback.claim(prKey)?.condition).toMatchObject({
          state: 'paused',
        }),
      );
      return { feedback, prKey };
    };
    const feedbackItems = async (credential: string) => {
      revocation.revoked = false;
      const read = await as(credential, 'GET', '/api/attention');
      expect(read.status, JSON.stringify(read.json)).toBe(200);
      return (read.json.data.items as Array<Record<string, any>>).filter(
        (item) => item.kind === 'pull-request-feedback',
      );
    };
    const notices = async () => {
      const service = configured.notificationService;
      return (await service.list()).filter(
        (notification) => notification.source === 'pull-request-feedback',
      );
    };
    return { as, feedbackItems, notices, pausedOnDelivery, configured };
  }

  test('a pause is both a Needs-you item and one notification; the operator may change it', async () => {
    const e = await setup();
    await e.pausedOnDelivery();
    const [item] = await e.feedbackItems(OPERATOR);
    expect(item).toMatchObject({
      kind: 'pull-request-feedback',
      title: '#42 still failing after 3 rounds',
      sessionId: CHAT,
      source: { conversationId: CHAT, identity: PR },
      viewerMayChange: true,
    });
    await vi.waitFor(async () => expect(await e.notices()).toHaveLength(1));
    const [notice] = await e.notices();
    expect(notice).toMatchObject({
      category: 'pull-request-feedback',
      title: 'Agent paused on #42: checks still failing after 3 rounds',
      status: 'delivered',
    });
    // The item names its notification, so the inbox shows the fact once.
    expect((await e.feedbackItems(OPERATOR))[0]?.source.notificationId).toBe(
      notice!.id,
    );
  });

  test('who may change it is the feedback routes’ own rule: not a credential revoked mid-request', async () => {
    const e = await setup();
    await e.pausedOnDelivery();
    expect((await e.feedbackItems(OPERATOR))[0]?.viewerMayChange).toBe(true);
    // Revoked after ingress: the principal is no longer current.
    const revoked = await e.feedbackItems(REVOKED);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.viewerMayChange).toBe(false);
  });

  test('a chat the reader may not read shows no item', async () => {
    const e = await setup();
    await e.pausedOnDelivery(OTHERS_CHAT);
    expect(await e.feedbackItems(OPERATOR)).toEqual([]);
  });

  test('Send again lifts the pause: the item goes and its notification is settled', async () => {
    const e = await setup();
    await e.pausedOnDelivery();
    await vi.waitFor(async () => expect(await e.notices()).toHaveLength(1));
    const sent = await e.as(
      OPERATOR,
      'POST',
      `/api/pull-request-feedback/conversations/${CHAT}/send-again`,
      { identity: PR },
    );
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    expect(await e.feedbackItems(OPERATOR)).toEqual([]);
    await vi.waitFor(async () =>
      expect((await e.notices()).map((notice) => notice.status)).toEqual([
        'expired',
      ]),
    );
  });

  test('Turn off settles the notification too', async () => {
    const e = await setup();
    await e.pausedOnDelivery();
    await vi.waitFor(async () => expect(await e.notices()).toHaveLength(1));
    const off = await e.as(
      OPERATOR,
      'DELETE',
      `/api/pull-request-feedback/conversations/${CHAT}`,
      { identity: PR },
    );
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    expect(await e.feedbackItems(OPERATOR)).toEqual([]);
    await vi.waitFor(async () =>
      expect((await e.notices()).map((notice) => notice.status)).toEqual([
        'expired',
      ]),
    );
  });
});
