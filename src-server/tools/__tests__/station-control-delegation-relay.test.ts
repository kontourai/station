/**
 * #2377 slice C2b: a station-control tool never reaches another Station.
 *
 * A tool's call (no orchestration service, no remote forwarder) that names a
 * saved Environment goes to THIS Station's own route with the Environment
 * named, and the route forwards it after its scope check. These tests drive
 * every dispatch-family entry point the station-control tools call, record
 * every request the tool process makes, and pin that:
 *
 * - every request goes to this Station's API origin, and none to the peer;
 * - none reads an Environment's transport or credential (`/api/environments`);
 * - the Environment the agent chose is named to this Station's route.
 *
 * It also pins the two ways server code could slip past the seam: in-process
 * code composed without a forwarder fails closed instead of relaying to
 * itself, and a remote target not minted by the forwarder is refused.
 */
import { agentId } from '@kontourai/station-contracts/agent-identity';
import { environmentId } from '@kontourai/station-contracts/execution-target';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  continueDelegatedTask,
  continueExecutionTargetMessage,
  delegateTask,
  discoverDelegationOptions,
  executeExecutionTargetMessage,
  interruptDelegatedTask,
  listDelegatedTasks,
  observeDelegatedTask,
  observeDelegatedTaskEvents,
  respondToDelegatedTaskRequest,
} from '../station-control-delegation.js';

const CURRENT_API = 'http://relay-current.test';
const PEER_API = 'http://peer-must-not-be-reached.test';
const SAVED = 'environment-saved-peer';
const ambientApiBase = process.env.STATION_API_BASE;
const ambientToken = process.env.STATION_INTERNAL_API_TOKEN;

interface Recorded {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
  signal: AbortSignal | null | undefined;
}

const recorded: Recorded[] = [];

beforeEach(() => {
  process.env.STATION_API_BASE = CURRENT_API;
  process.env.STATION_INTERNAL_API_TOKEN = 'relay-internal-token';
  recorded.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${CURRENT_API}/.well-known/station/v1`) {
        return new Response(JSON.stringify({ environmentId: 'env-self' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      let body: Record<string, unknown> | undefined;
      try {
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      } catch {
        body = undefined;
      }
      recorded.push({
        method: init?.method ?? 'GET',
        url,
        body,
        signal: init?.signal,
      });
      // Every relayed call is answered by a refusal: this suite pins where
      // the call went, not what the route answers.
      return new Response(
        JSON.stringify({ success: false, error: 'recorded' }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ambientApiBase === undefined) delete process.env.STATION_API_BASE;
  else process.env.STATION_API_BASE = ambientApiBase;
  if (ambientToken === undefined) delete process.env.STATION_INTERNAL_API_TOKEN;
  else process.env.STATION_INTERNAL_API_TOKEN = ambientToken;
});

const savedTarget = {
  environment: { kind: 'saved' as const, id: environmentId(SAVED) },
  agent: agentId('reviewer'),
  workspace: { kind: 'project' as const, projectSlug: 'station' },
};

const toolCalls: Array<
  [string, () => Promise<unknown>, (request: Recorded) => boolean, string]
> = [
  [
    'discoverDelegationOptions',
    () => discoverDelegationOptions({ environmentId: SAVED }),
    (r) => r.body?.environmentId === SAVED,
    '/api/orchestration/delegations/options',
  ],
  [
    'listDelegatedTasks',
    () => listDelegatedTasks({ environmentId: SAVED, userId: 'user-1' }),
    (r) => new URL(r.url).searchParams.get('environmentId') === SAVED,
    '/api/orchestration/delegations',
  ],
  [
    'observeDelegatedTask',
    () =>
      observeDelegatedTask({
        taskId: 'task:1',
        environmentId: SAVED,
        userId: 'user-1',
      }),
    (r) => new URL(r.url).searchParams.get('environmentId') === SAVED,
    '/api/orchestration/delegations/task%3A1',
  ],
  [
    'observeDelegatedTaskEvents',
    () =>
      observeDelegatedTaskEvents({
        taskId: 'task:1',
        environmentId: SAVED,
        userId: 'user-1',
      } as never),
    (r) => new URL(r.url).searchParams.get('environmentId') === SAVED,
    '/api/orchestration/delegations/task%3A1/events',
  ],
  [
    'continueDelegatedTask',
    () =>
      continueDelegatedTask({
        taskId: 'task:1',
        environmentId: SAVED,
        message: 'more',
        userId: 'user-1',
      } as never),
    (r) => r.body?.environmentId === SAVED,
    '/api/orchestration/delegations/task%3A1/continue',
  ],
  [
    'respondToDelegatedTaskRequest',
    () =>
      respondToDelegatedTaskRequest({
        taskId: 'task:1',
        requestId: 'request-1',
        decision: 'accept',
        environmentId: SAVED,
        userId: 'user-1',
      } as never),
    (r) => r.body?.environmentId === SAVED,
    '/api/orchestration/delegations/task%3A1/respond',
  ],
  [
    'interruptDelegatedTask',
    () =>
      interruptDelegatedTask({
        taskId: 'task:1',
        environmentId: SAVED,
        userId: 'user-1',
      }),
    (r) => r.body?.environmentId === SAVED,
    '/api/orchestration/delegations/task%3A1/interrupt',
  ],
  [
    'delegateTask',
    () =>
      delegateTask({
        target: savedTarget,
        prompt: 'Ship it',
        userId: 'user-1',
      } as never),
    (r) =>
      JSON.stringify(
        (r.body?.target as { environment?: unknown } | undefined)?.environment,
      ) === JSON.stringify({ kind: 'saved', id: SAVED }),
    '/api/orchestration/delegations',
  ],
  [
    'executeExecutionTargetMessage',
    () =>
      executeExecutionTargetMessage({
        target: savedTarget,
        message: 'hello',
        userId: 'user-1',
      } as never),
    (r) =>
      JSON.stringify(
        (r.body?.target as { environment?: unknown } | undefined)?.environment,
      ) === JSON.stringify({ kind: 'saved', id: SAVED }),
    '/api/orchestration/chat',
  ],
  [
    'continueExecutionTargetMessage',
    () =>
      continueExecutionTargetMessage({
        conversationId: 'conv-1',
        environment: { kind: 'saved', id: environmentId(SAVED) },
        message: 'again',
        userId: 'user-1',
      } as never),
    (r) =>
      JSON.stringify(r.body?.environment) ===
      JSON.stringify({ kind: 'saved', id: SAVED }),
    '/api/orchestration/chat/conv-1/continue',
  ],
];

describe('a tool call naming a saved Environment reaches only this Station (#2377 C2b)', () => {
  test.each(toolCalls)(
    '%s names the Environment to this Station and never contacts the peer',
    async (_name, call, namesEnvironment, pathPrefix) => {
      await call().catch(() => undefined);
      expect(recorded.length).toBeGreaterThan(0);
      for (const request of recorded) {
        expect(request.url.startsWith(`${CURRENT_API}/`)).toBe(true);
        expect(request.url).not.toContain(PEER_API);
        expect(new URL(request.url).pathname).not.toMatch(
          /^\/api\/environments\//,
        );
        // The route owns the timeout: the tool's own call carries none, so
        // it never gives up before the route reports a slow peer.
        expect(request.signal ?? undefined).toBeUndefined();
      }
      const relayed = recorded.filter((request) =>
        new URL(request.url).pathname.startsWith(pathPrefix),
      );
      expect(relayed.length).toBeGreaterThan(0);
      expect(relayed.some(namesEnvironment)).toBe(true);
    },
  );
});

describe('server code cannot slip past the remote seam', () => {
  test('in-process code composed without a forwarder fails closed instead of relaying to itself', async () => {
    const service = new Proxy(
      {},
      {
        get: () => {
          throw new Error('the orchestration service must not be reached');
        },
      },
    );
    await expect(
      delegateTask(
        { target: savedTarget, prompt: 'Ship it', userId: 'user-1' } as never,
        service as never,
      ),
    ).rejects.toThrow(/composed without its remote forwarder/);
    expect(recorded).toEqual([]);
  });

  test('a remote target the forwarder did not mint is refused before any request', async () => {
    const forged = {
      resolve: async () => ({
        kind: 'peer' as const,
        apiBase: PEER_API,
        environmentId: SAVED,
        environmentName: 'forged',
        requestOptions: { headers: { Authorization: 'Bearer forged' } },
      }),
    };
    await expect(
      delegateTask(
        { target: savedTarget, prompt: 'Ship it', userId: 'user-1' } as never,
        undefined,
        forged,
      ),
    ).rejects.toThrow(/must come from its forwarder/);
    expect(recorded).toEqual([]);
  });
});
