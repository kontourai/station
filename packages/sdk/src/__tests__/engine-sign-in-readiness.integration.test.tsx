/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { _setApiBase } from '../api-core';
import { setClientCredentialResolver } from '../client/http';
import { useEngineSignInAttemptQuery } from '../engine-sign-in';
import { useEngineConnectionsQuery } from '../query-domains/workspaceConnections';

afterEach(() => {
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
});

const API = 'https://station.example.test';
const scope = { apiBase: API, authorityKey: 'sign-in-readiness' };

/** The Claude Code connection as `/api/connections/agents` serves it. */
function claudeConnection(signedIn: boolean) {
  return {
    id: 'claude',
    kind: 'agent',
    type: 'claude',
    name: 'Claude Code',
    status: signedIn ? 'ready' : 'missing_prerequisites',
    enabled: true,
    capabilities: ['agent-runtime'],
    config: {},
    setup: { state: 'ready', detected: true, configured: true },
    prerequisites: [
      {
        id: 'claude-auth',
        name: 'Claude Code login',
        description: signedIn
          ? 'Claude Code CLI credentials are present on this Station.'
          : 'Claude Code CLI is not authenticated.',
        status: signedIn ? 'installed' : 'missing',
        category: 'required',
        installGuide: { steps: ['Sign in to Claude Code'] },
      },
    ],
  };
}

const attempt = (state: 'running' | 'succeeded') => ({
  id: 'attempt-1',
  methodId: 'claude-login',
  kind: 'terminal',
  state,
  startedAt: '2026-11-23T00:00:00.000Z',
});

test('a sign-in this client sees finish re-reads the engine connections without a remount', async () => {
  _setApiBase(API);
  setClientCredentialResolver(() => ({
    origin: API,
    requestAuthority: { ...scope, isCurrent: () => true },
  }));
  let signedIn = false;
  let attemptState: 'running' | 'succeeded' = 'running';
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/api/connections/agents'))
      return Response.json({
        success: true,
        data: [claudeConnection(signedIn)],
      });
    if (url.endsWith('/acp/connections/claude/sign-in/attempt'))
      return Response.json({ success: true, data: attempt(attemptState) });
    return Response.json(
      { success: false, error: `unexpected ${url}` },
      { status: 404 },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  // The engines read keeps its data for minutes; only the sign-in's own
  // refresh can bring the new sign-in state in.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5 * 60_000 } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }
  const view = renderHook(
    () => ({
      engines: useEngineConnectionsQuery(),
      attempt: useEngineSignInAttemptQuery('claude', scope, true),
    }),
    { wrapper: Wrapper },
  );
  const authStatus = () =>
    view.result.current.engines.data?.[0]?.prerequisites.find(
      (prerequisite) => prerequisite.id === 'claude-auth',
    )?.status;
  try {
    await waitFor(() => expect(authStatus()).toBe('missing'));
    await waitFor(() =>
      expect(
        view.result.current.attempt.data?.state,
        String(view.result.current.attempt.error),
      ).toBe('running'),
    );
    // The person approves the sign-in; the attempt's next poll says so.
    signedIn = true;
    attemptState = 'succeeded';
    await waitFor(() => expect(authStatus()).toBe('installed'), {
      timeout: 5_000,
    });
  } finally {
    view.unmount();
    client.clear();
  }
});
