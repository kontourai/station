/**
 * #3304: a delegation target whose engine connection is not ready must say
 * WHICH prerequisite is missing and how to fix it, not only that the
 * connection is not ready. Drives `delegateTask` through the real target
 * resolution (`readConnection`), with only the HTTP edge stubbed.
 */
import { agentId } from '@kontourai/station-contracts/agent-identity';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const CURRENT_API = 'http://127.0.0.1:3141';
const fetchMock = vi.fn();

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubStation(connection: Record<string, unknown>): void {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === `${CURRENT_API}/.well-known/station/v1`) {
      return json({ environmentId: 'environment-current' });
    }
    if (url === `${CURRENT_API}/api/agents/claude-agent`) {
      return json({
        success: true,
        data: {
          slug: 'claude-agent',
          name: 'Claude Agent',
          available: true,
          execution: { agentConnectionId: 'claude' },
        },
      });
    }
    if (url === `${CURRENT_API}/api/connections/claude`) {
      return json({ success: true, data: connection });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

const base = {
  id: 'claude',
  kind: 'agent',
  type: 'claude',
  enabled: true,
  capabilities: ['agent-runtime'],
  config: { provider: 'claude' },
};

async function delegate(): Promise<unknown> {
  const { delegateTask } = await import('../station-control-delegation.js');
  return delegateTask(
    {
      prompt: 'Do the thing',
      userId: 'human:test:delegator',
      target: {
        environment: { kind: 'current' },
        agent: agentId('claude-agent'),
      },
    },
    {} as never,
  );
}

describe('#3304: not-ready engine connection names the missing prerequisite', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  test('a missing prerequisite is named with its fix step and command', async () => {
    stubStation({
      ...base,
      status: 'missing_prerequisites',
      prerequisites: [
        {
          id: 'claude-auth',
          name: 'Claude sign-in',
          description: 'Claude must be signed in.',
          status: 'missing',
          category: 'required',
          installGuide: {
            steps: ['Sign in to Claude'],
            commands: ['claude auth login'],
          },
        },
        {
          id: 'optional-thing',
          name: 'Optional thing',
          description: 'Not needed.',
          status: 'missing',
          category: 'optional',
        },
      ],
    });
    const error = await delegate().then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).toContain("Engine connection 'claude'");
    expect(error?.message).toContain('not ready for delegated work');
    expect(error?.message).toContain('Claude sign-in (claude-auth) is missing');
    expect(error?.message).toContain('Sign in to Claude');
    expect(error?.message).toContain('`claude auth login`');
    expect(error?.message).not.toContain('Optional thing');
  });

  test('readiness evidence free text is never surfaced to the delegator', async () => {
    stubStation({
      ...base,
      status: 'error',
      prerequisites: [],
      readinessEvidence: {
        summary: 'smoke failed: 401 for key sk-secret at /Users/brian/.claude',
        action: 'Reconnect at /Users/brian/.claude using sk-secret.',
      },
    });
    const error = await delegate().then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).toContain('not ready for delegated work (error)');
    expect(error?.message).toContain('station connections test claude');
    expect(error?.message).toContain('Check this connection in Connections');
    expect(error?.message).not.toContain('sk-secret');
    expect(error?.message).not.toContain('/Users/brian');
  });
});
