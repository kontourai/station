import { agentId } from '@kontourai/station-contracts/agent-identity';
import { environmentId } from '@kontourai/station-contracts/execution-target';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  continueDelegatedTask,
  continueExecutionTargetMessage,
  delegateTask,
  executeExecutionTargetMessage,
} from '../station-control-delegation.js';

const CURRENT_API = 'http://canonical-controller.test';
const REMOTE_API = 'https://canonical-peer.test';
const REMOTE_ENVIRONMENT = environmentId('environment-remote');

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Station Control canonical cross-Environment execution routing', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    process.env.STATION_API_BASE = CURRENT_API;
    process.env.STATION_INTERNAL_API_TOKEN = 'controller-token';
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `${CURRENT_API}/.well-known/station/v1`) {
        return json({ environmentId: 'environment-current' });
      }
      if (url === `${CURRENT_API}/api/environments/ssh`) {
        return json({ success: true, data: [] });
      }
      if (
        url ===
        `${CURRENT_API}/api/environments/peers/environment-remote/credential`
      ) {
        return json({
          success: true,
          data: {
            environmentId: 'environment-remote',
            apiBase: REMOTE_API,
            scope: 'orchestration:operate',
            credential: 'remote-bearer',
            label: 'Remote Station',
          },
        });
      }
      if (url === `${REMOTE_API}/api/orchestration/chat`) {
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer remote-bearer',
        );
        return json({
          success: true,
          data: {
            conversationId: 'conversation:remote',
            sessionId: 'conversation:remote',
            providerTurnId: 'provider-turn-remote-start',
            target: { kind: 'agent', id: 'codex' },
            resolution: {},
          },
        });
      }
      if (
        url ===
        `${REMOTE_API}/api/orchestration/chat/conversation%3Aremote/continue`
      ) {
        return json({
          success: true,
          data: {
            conversationId: 'conversation:remote',
            sessionId: 'conversation:remote',
            providerTurnId: 'provider-turn-remote-continue',
            target: { kind: 'agent', id: 'codex' },
            resolution: {},
          },
        });
      }
      if (url === `${REMOTE_API}/api/orchestration/delegations`) {
        return json({
          success: true,
          data: {
            taskId: 'task:remote',
            sessionId: 'task:remote',
            status: 'dispatched',
            environment: {
              id: 'environment-remote',
              name: 'Remote Station',
              kind: 'current',
            },
            target: { kind: 'agent', id: 'codex' },
            resumable: true,
          },
        });
      }
      if (
        url ===
        `${REMOTE_API}/api/orchestration/delegations/task%3Aremote/continue`
      ) {
        return json({
          success: true,
          data: {
            taskId: 'task:remote',
            sessionId: 'task:remote',
            status: 'dispatched',
            environment: {
              id: 'environment-remote',
              name: 'Remote Station',
              kind: 'current',
            },
            target: { kind: 'agent', id: 'codex' },
            resumable: true,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  test('foreground execution rewrites the saved Environment only at the remote canonical boundary', async () => {
    const receipt = await executeExecutionTargetMessage({
      message: 'Probe the host',
      target: {
        environment: { kind: 'saved', id: REMOTE_ENVIRONMENT },
        agent: agentId('codex'),
      },
    });

    const remote = fetchMock.mock.calls.find(
      ([url]) => String(url) === `${REMOTE_API}/api/orchestration/chat`,
    );
    expect(JSON.parse(String(remote?.[1]?.body))).toMatchObject({
      message: 'Probe the host',
      target: { environment: { kind: 'current' }, agent: 'codex' },
    });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith('/api/orchestration/commands'),
      ),
    ).toBe(false);
    expect(receipt.providerTurnId).toBe('provider-turn-remote-start');
  });

  test('foreground continuation repeats only Environment routing and leaves the remote binding authoritative', async () => {
    const receipt = await continueExecutionTargetMessage({
      conversationId: 'conversation:remote',
      environment: { kind: 'saved', id: REMOTE_ENVIRONMENT },
      message: 'Continue the probe',
    });

    const remote = fetchMock.mock.calls.find(
      ([url]) =>
        String(url) ===
        `${REMOTE_API}/api/orchestration/chat/conversation%3Aremote/continue`,
    );
    expect(JSON.parse(String(remote?.[1]?.body))).toEqual({
      message: 'Continue the probe',
    });
    expect(receipt.providerTurnId).toBe('provider-turn-remote-continue');
  });

  test('delegated start and continuation use only remote canonical delegation endpoints', async () => {
    await delegateTask({
      prompt: 'Run focused tests',
      target: {
        environment: { kind: 'saved', id: REMOTE_ENVIRONMENT },
        agent: agentId('codex'),
      },
    });
    await continueDelegatedTask({
      taskId: 'task:remote',
      environmentId: 'environment-remote',
      message: 'Now run typecheck',
    });

    const start = fetchMock.mock.calls.find(
      ([url]) => String(url) === `${REMOTE_API}/api/orchestration/delegations`,
    );
    expect(JSON.parse(String(start?.[1]?.body))).toMatchObject({
      prompt: 'Run focused tests',
      target: { environment: { kind: 'current' }, agent: 'codex' },
    });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith('/api/orchestration/commands'),
      ),
    ).toBe(false);
  });
});
