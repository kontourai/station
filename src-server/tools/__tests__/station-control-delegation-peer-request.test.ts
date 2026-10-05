import { join } from 'node:path';
import type { ReviewPendingAttentionItem } from '@kontourai/station-contracts/attention';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import {
  OrchestrationService,
  PEER_PENDING_REQUEST_ID_MAX_CHARS,
  PEER_PENDING_REQUEST_TITLE_MAX_CHARS,
} from '../../services/orchestration/orchestration-service.js';
import { AttentionProjectionService } from '../../services/projects/attention-projection.js';
import { createRemoteStationForwarder } from '../../services/remote-stations/remote-station-forwarder.js';
import {
  observeDelegatedTask,
  PEER_RESPOND_ENVIRONMENT_MISMATCH_MESSAGE,
  PEER_RESPOND_FORBIDDEN_MESSAGE,
  respondToDelegatedTaskRequest,
} from '../station-control-delegation.js';
import { LocalStationRefusal } from '../station-control-shared.js';

/**
 * A delegated task running on a PAIRED Station: its open request reaches this
 * Station only through that Station's delegated-task status read
 * (`pendingRequest`). These tests drive the REAL status read
 * (`observeDelegatedTask` over a real `RemoteStationForwarder`, HTTP stubbed
 * at `fetch` in the shape the paired Station answers), the REAL mirror-record
 * writers on a real event store, and the REAL attention projection — so the
 * item's `peerRequestReference` is what production derives from what the
 * paired Station sent.
 */
process.env.STATION_API_BASE = 'http://peer-request.test';
process.env.STATION_INTERNAL_API_TOKEN = 'internal-test-token';

const CURRENT_API = 'http://peer-request.test';
const PEER_API = 'http://127.0.0.1:45177';
const ENVIRONMENT_ID = 'environment-peer';
const TASK_ID = 'task-peer-request';
/** Another paired Station this Station also holds a credential for. */
const OTHER_ENVIRONMENT_ID = 'environment-other';
const OTHER_PEER_API = 'http://127.0.0.1:45178';
/** A verified SSH environment, reached through a loopback tunnel. */
const SSH_ENVIRONMENT_ID = 'environment-ssh';
const SSH_API = 'http://127.0.0.1:45179';
const fetchMock = vi.fn<typeof fetch>();

const remote = createRemoteStationForwarder({
  ssh: { list: () => [], connect: async () => undefined as never },
  peers: {
    get: (environmentId: string) =>
      environmentId === ENVIRONMENT_ID || environmentId === OTHER_ENVIRONMENT_ID
        ? {
            environmentId,
            apiBase:
              environmentId === ENVIRONMENT_ID ? PEER_API : OTHER_PEER_API,
            scope: 'orchestration:read orchestration:operate',
            credential: 'peer-secret',
            label: 'Station B',
            createdAt: 0,
            updatedAt: 0,
          }
        : null,
  },
} as never);

const sshRemote = (() => {
  const view = {
    profile: {
      id: 'ssh-profile-1',
      name: 'Box S',
      environmentId: SSH_ENVIRONMENT_ID,
      verifiedProjectPath: '/srv/project',
      remoteHome: '/home/s',
    },
    state: { phase: 'connected', localUrl: SSH_API },
  } as never;
  return createRemoteStationForwarder({
    ssh: { list: () => [view], connect: async () => view },
    peers: { get: () => null },
  } as never);
})();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The paired Station's `GET /api/orchestration/delegations/:taskId` body. */
function peerSnapshot(pendingRequest?: Record<string, unknown>) {
  return {
    conversationId: TASK_ID,
    taskId: TASK_ID,
    sessionId: 'peer-session-1',
    currentSessionId: 'peer-session-1',
    status: 'review_pending',
    environment: {
      id: 'peer-self',
      name: 'Current environment',
      kind: 'current',
    },
    target: { kind: 'agent', id: 'codex' },
    eventCount: 4,
    canInterrupt: false,
    resumable: true,
    ...(pendingRequest ? { pendingRequest } : {}),
  };
}

// Created before the cleanup hook below, so it removes the directories
// after the stores in them have closed (after-hooks run in reverse order).
const makeTempDir = trackTempDirs();
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.unstubAllGlobals();
});

let peerResponse: () => Response;
let currentRespondCalls: number;
let sshRespondCalls: number;
let sshRespondBody: Record<string, unknown>;
let currentRespondBody: Record<string, unknown>;
let respondCalls: Array<{ url: string; body: Record<string, unknown> }>;
let respondStatus: number;
/** The refusal body the answering Station sends with a non-200 respond. */
let respondRefusalBody: Record<string, unknown>;

beforeEach(() => {
  respondCalls = [];
  currentRespondCalls = 0;
  sshRespondCalls = 0;
  sshRespondBody = {};
  currentRespondBody = {};
  respondStatus = 200;
  respondRefusalBody = { success: false, error: 'not allowed here' };
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `${CURRENT_API}/.well-known/station/v1`)
      return json({ environmentId: 'environment-here' });
    if (url === `${PEER_API}/api/orchestration/delegations/${TASK_ID}`)
      return peerResponse();
    if (url === `${SSH_API}/api/orchestration/delegations/${TASK_ID}/respond`) {
      sshRespondCalls += 1;
      return json(sshRespondBody, 403);
    }
    // THIS Station's own respond route, reached by an input naming no
    // environment (a `current` target): it answers with its own refusal.
    if (
      url === `${CURRENT_API}/api/orchestration/delegations/${TASK_ID}/respond`
    ) {
      currentRespondCalls += 1;
      return json(currentRespondBody, 403);
    }
    if (
      url === `${PEER_API}/api/orchestration/delegations/${TASK_ID}/respond`
    ) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      respondCalls.push({ url, body });
      if (respondStatus !== 200) return json(respondRefusalBody, respondStatus);
      return json({
        success: true,
        data: {
          conversationId: TASK_ID,
          taskId: TASK_ID,
          sessionId: 'peer-session-1',
          currentSessionId: 'peer-session-1',
          requestId: body.requestId,
          status: 'resolved',
          decision: body.decision,
          environment: {
            id: 'peer-self',
            name: 'Current environment',
            kind: 'current',
          },
          target: { kind: 'agent', id: 'codex' },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
});

function fixture() {
  const home = makeTempDir('station-peer-request-');
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
  const threadId = service.recordPeerDelegationActivityDispatch({
    taskId: TASK_ID,
    conversationId: TASK_ID,
    prompt: 'Run the release checks',
    userId: 'default',
    environment: { id: ENVIRONMENT_ID, name: 'Station B', kind: 'peer' },
    target: { kind: 'agent', id: 'codex' },
  });
  const projection = new AttentionProjectionService(
    { list: () => [] } as never,
    service,
    { getRunConsole: async () => ({ gates: [] }) } as never,
  );
  const observe = () =>
    observeDelegatedTask(
      { taskId: TASK_ID, environmentId: ENVIRONMENT_ID, userId: 'default' },
      service,
      remote,
    );
  const item = async (viewer?: {
    mayRespondToPeerTask?: (t: string) => boolean;
  }) =>
    (await projection.list(undefined, viewer)).items.find(
      (candidate): candidate is ReviewPendingAttentionItem =>
        candidate.kind === 'review_pending' &&
        candidate.source.threadId === threadId,
    );
  return { service, threadId, observe, item };
}

describe("a paired Station's open request reaches this Station's inbox", () => {
  test('the status read stores it and the projection exposes it as the paired Station request', async () => {
    const { observe, item } = fixture();
    peerResponse = () =>
      json({
        success: true,
        data: peerSnapshot({
          id: 'req-peer-1',
          type: 'approval',
          title: 'Allow bash',
        }),
      });
    await observe();

    const projected = await item({ mayRespondToPeerTask: () => true });
    expect(projected).toMatchObject({
      environmentKind: 'peer',
      peerRequestReference: {
        environmentId: ENVIRONMENT_ID,
        taskId: TASK_ID,
        requestId: 'req-peer-1',
        requestType: 'approval',
      },
      viewerCanRespond: true,
      // Presented through the same wording a local approval gets.
      title: 'Tool call awaiting approval: Allow bash',
    });
    // Never wired to this Station's own request routes.
    expect(projected).not.toHaveProperty('requestReference');
    expect(projected).not.toHaveProperty('inputReference');
  });

  test('viewerCanRespond follows the caller check and is absent without one', async () => {
    const { observe, item } = fixture();
    peerResponse = () =>
      json({
        success: true,
        data: peerSnapshot({ id: 'req-peer-2', type: 'permission' }),
      });
    await observe();
    const asked: string[] = [];
    expect(
      await item({
        mayRespondToPeerTask: (taskId) => {
          asked.push(taskId);
          return false;
        },
      }),
    ).toMatchObject({ viewerCanRespond: false });
    expect(asked).toEqual([TASK_ID]);
    expect(await item()).not.toHaveProperty('viewerCanRespond');
  });

  test('a later status read without a request clears it', async () => {
    const { observe, item } = fixture();
    peerResponse = () =>
      json({
        success: true,
        data: peerSnapshot({ id: 'req-peer-3', type: 'approval' }),
      });
    await observe();
    expect(await item()).toHaveProperty('peerRequestReference');

    peerResponse = () => json({ success: true, data: peerSnapshot() });
    await observe();
    const after = await item();
    expect(after).toBeDefined();
    expect(after).not.toHaveProperty('peerRequestReference');
  });
});

describe('a decision on it is forwarded to the paired Station', () => {
  test('respond posts the request id and decision to the paired Station and clears the mirror', async () => {
    const { service, observe, item } = fixture();
    peerResponse = () =>
      json({
        success: true,
        data: peerSnapshot({ id: 'req-peer-4', type: 'approval' }),
      });
    await observe();

    await expect(
      respondToDelegatedTaskRequest(
        {
          taskId: TASK_ID,
          environmentId: ENVIRONMENT_ID,
          requestId: 'req-peer-4',
          decision: 'accept',
          userId: 'default',
        } as never,
        service,
        remote,
      ),
    ).resolves.toMatchObject({ status: 'resolved', requestId: 'req-peer-4' });
    expect(respondCalls).toHaveLength(1);
    expect(respondCalls[0].body).toMatchObject({
      requestId: 'req-peer-4',
      decision: 'accept',
    });
    expect(await item()).not.toHaveProperty('peerRequestReference');
  });

  test("a 403 from the paired Station surfaces as this Station's refusal sentence", async () => {
    const { observe } = fixture();
    peerResponse = () =>
      json({
        success: true,
        data: peerSnapshot({ id: 'req-peer-5', type: 'approval' }),
      });
    await observe();
    respondStatus = 403;
    await expect(
      respondToDelegatedTaskRequest(
        {
          taskId: TASK_ID,
          environmentId: ENVIRONMENT_ID,
          requestId: 'req-peer-5',
          decision: 'decline',
          userId: 'default',
        } as never,
        undefined,
        remote,
      ),
    ).rejects.toThrow(PEER_RESPOND_FORBIDDEN_MESSAGE);
  });

  // #3338: the peer sentence is the PAIRED Station's 403 only. The peer is
  // free to send any code (`station_control_caller_required` included) and
  // any text; neither may cross this seam, as a code or as a cause.
  test('a paired Station 403 carrying a local-looking code and detail keeps only the peer sentence', async () => {
    const { observe } = fixture();
    peerResponse = () =>
      json({
        success: true,
        data: peerSnapshot({ id: 'req-peer-6', type: 'approval' }),
      });
    await observe();
    respondStatus = 403;
    respondRefusalBody = {
      success: false,
      code: 'station_control_caller_required',
      error: 'PEER-INTERNAL-DETAIL /srv/peer/secret-path',
    };
    const error = await respondToDelegatedTaskRequest(
      {
        taskId: TASK_ID,
        environmentId: ENVIRONMENT_ID,
        requestId: 'req-peer-6',
        decision: 'decline',
        userId: 'default',
      } as never,
      undefined,
      remote,
    ).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe(PEER_RESPOND_FORBIDDEN_MESSAGE);
    expect(error?.message).not.toContain('PEER-INTERNAL-DETAIL');
    expect(error?.cause).toBeUndefined();
    expect(error).not.toHaveProperty('code');
  });

  test("a 403 from THIS Station keeps its typed code and not the paired Station's sentence", async () => {
    currentRespondBody = {
      success: false,
      code: 'station_control_caller_required',
      error: 'This action needs a verified calling session.',
    };
    const error = await respondToDelegatedTaskRequest(
      {
        taskId: TASK_ID,
        requestId: 'req-local-1',
        decision: 'accept',
        userId: 'default',
      } as never,
      undefined,
      remote,
    ).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(currentRespondCalls).toBe(1);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toBe(PEER_RESPOND_FORBIDDEN_MESSAGE);
    expect(error?.cause).toBeInstanceOf(LocalStationRefusal);
    expect(error?.cause).toMatchObject({
      refusalCode: 'station_control_caller_required',
    });
  });

  // An SSH target is not a paired Station: its 403 never earns the
  // paired-Station sentence. It is not this Station either, so it carries no
  // typed local code; it gets the generic refusal, as before #3315.
  test("a 403 from an SSH target is neither the paired Station's sentence nor a local code", async () => {
    sshRespondBody = {
      success: false,
      code: 'station_control_caller_required',
      error: 'SSH-HOST-DETAIL /home/s/secret',
    };
    const error = await respondToDelegatedTaskRequest(
      {
        taskId: TASK_ID,
        environmentId: SSH_ENVIRONMENT_ID,
        requestId: 'req-ssh-1',
        decision: 'accept',
        userId: 'default',
      } as never,
      undefined,
      sshRemote,
    ).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(sshRespondCalls).toBe(1);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe(
      'The selected Station could not resolve the delegated task request',
    );
    expect(error?.message).not.toBe(PEER_RESPOND_FORBIDDEN_MESSAGE);
    expect(error?.message).not.toContain('SSH-HOST-DETAIL');
    expect(error?.cause).toBeUndefined();
  });
});

describe('bounds on what the paired Station reports', () => {
  test(`an id of exactly ${PEER_PENDING_REQUEST_ID_MAX_CHARS} characters is stored`, async () => {
    const { observe, item } = fixture();
    const id = 'r'.repeat(PEER_PENDING_REQUEST_ID_MAX_CHARS);
    expect(id).toHaveLength(512);
    peerResponse = () =>
      json({ success: true, data: peerSnapshot({ id, type: 'approval' }) });
    await observe();
    expect((await item())?.peerRequestReference?.requestId).toBe(id);
  });

  test('an id one character over the bound is refused, not truncated', async () => {
    const { observe, item } = fixture();
    peerResponse = () =>
      json({
        success: true,
        data: peerSnapshot({
          id: 'r'.repeat(PEER_PENDING_REQUEST_ID_MAX_CHARS + 1),
          type: 'approval',
        }),
      });
    await observe();
    const projected = await item();
    expect(projected).toBeDefined();
    expect(projected).not.toHaveProperty('peerRequestReference');
  });

  test('a title over the bound is cut with a visible ellipsis', async () => {
    const { service, observe, threadId } = fixture();
    peerResponse = () =>
      json({
        success: true,
        data: peerSnapshot({
          id: 'req-long-title',
          type: 'approval',
          title: 't'.repeat(PEER_PENDING_REQUEST_TITLE_MAX_CHARS + 1),
        }),
      });
    await observe();
    const summary = (
      await service.listSessionReadModel(
        sessionReadAuthorityFromRequest('default', undefined, undefined),
      )
    ).find((session) => session.threadId === threadId);
    const title = summary?.delegation?.peerPendingRequest?.title ?? '';
    expect(Array.from(title)).toHaveLength(
      PEER_PENDING_REQUEST_TITLE_MAX_CHARS,
    );
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('a decision goes only to the recorded hosting Station', () => {
  test('a respond naming another paired Station is refused before any request', async () => {
    const { service, observe } = fixture();
    peerResponse = () =>
      json({
        success: true,
        data: peerSnapshot({ id: 'req-peer-6', type: 'approval' }),
      });
    await observe();
    // Another paired Station IS recorded, but as host of a different task:
    // that must not make it a host of this one.
    service.recordPeerDelegationActivityDispatch({
      taskId: 'task-elsewhere',
      conversationId: 'task-elsewhere',
      prompt: 'Unrelated work',
      userId: 'default',
      environment: {
        id: OTHER_ENVIRONMENT_ID,
        name: 'Station C',
        kind: 'peer',
      },
      target: { kind: 'agent', id: 'codex' },
    });
    const before = fetchMock.mock.calls.length;
    await expect(
      respondToDelegatedTaskRequest(
        {
          taskId: TASK_ID,
          environmentId: OTHER_ENVIRONMENT_ID,
          requestId: 'req-peer-6',
          decision: 'accept',
          userId: 'default',
        } as never,
        service,
        remote,
      ),
    ).rejects.toThrow(PEER_RESPOND_ENVIRONMENT_MISMATCH_MESSAGE);
    expect(respondCalls).toHaveLength(0);
    expect(
      fetchMock.mock.calls
        .slice(before)
        .some(([url]) => String(url).startsWith(OTHER_PEER_API)),
    ).toBe(false);
  });
});
