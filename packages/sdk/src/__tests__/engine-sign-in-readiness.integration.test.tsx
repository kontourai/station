/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { _setApiBase } from '../api-core';
import { setClientCredentialResolver } from '../client/http';
import {
  useEngineHostAuthLoginQuery,
  useEngineSignInAttemptQuery,
  useEngineSignInCheckMutation,
} from '../engine-sign-in';
import { useEngineConnectionsQuery } from '../query-domains/workspaceConnections';

afterEach(() => {
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
});

let client = new QueryClient();
function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

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
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5 * 60_000 } },
  });
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

/** A stubbed Station: the engines read, plus the given sign-in routes. */
function station(routes: Record<string, () => unknown>) {
  const state = { signedIn: false };
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/api/connections/agents'))
      return Response.json({
        success: true,
        data: [claudeConnection(state.signedIn)],
      });
    for (const [suffix, answer] of Object.entries(routes))
      if (url.endsWith(suffix))
        return Response.json({ success: true, data: answer() });
    return Response.json(
      { success: false, error: `unexpected ${url}` },
      { status: 404 },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  _setApiBase(API);
  setClientCredentialResolver(() => ({
    origin: API,
    requestAuthority: { ...scope, isCurrent: () => true },
  }));
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5 * 60_000 } },
  });
  return state;
}

function view(state: 'authenticated' | 'unauthenticated') {
  return {
    connectionId: 'claude',
    engineName: 'Claude Code',
    status: {
      state,
      source: 'status-command',
      observedAt: '2026-11-23T00:00:00.000Z',
      checkable: true,
    },
    credentials: [],
    allowed: { signIn: true, terminal: true },
  };
}

test('a sign-in check that answers authenticated re-reads the engine connections', async () => {
  const stationState = station({
    '/acp/connections/claude/sign-in/check': () =>
      view(stationState.signedIn ? 'authenticated' : 'unauthenticated'),
  });
  const hook = renderHook(
    () => ({
      engines: useEngineConnectionsQuery(),
      check: useEngineSignInCheckMutation('claude', scope),
    }),
    { wrapper: Wrapper },
  );
  const authStatus = () =>
    hook.result.current.engines.data?.[0]?.prerequisites.find(
      (prerequisite) => prerequisite.id === 'claude-auth',
    )?.status;
  try {
    await waitFor(() => expect(authStatus()).toBe('missing'));
    // The person signed in in a terminal; Check sign-in sees it.
    stationState.signedIn = true;
    await act(() => hook.result.current.check.mutateAsync());
    await waitFor(() => expect(authStatus()).toBe('installed'));
  } finally {
    hook.unmount();
    client.clear();
  }
});

test('a Station-run sign-in that completes re-reads the engine connections', async () => {
  let phase: 'awaiting-approval' | 'completed' = 'awaiting-approval';
  const stationState = station({
    '/acp/connections/claude/host-auth/login': () => ({
      kind: 'openai.chatgpt-auth-tokens',
      phase,
      startedAt: '2026-11-23T00:00:00.000Z',
      expiresAt: '2026-11-23T00:15:00.000Z',
    }),
  });
  const hook = renderHook(
    () => ({
      engines: useEngineConnectionsQuery(),
      login: useEngineHostAuthLoginQuery('claude', scope, true),
    }),
    { wrapper: Wrapper },
  );
  const authStatus = () =>
    hook.result.current.engines.data?.[0]?.prerequisites.find(
      (prerequisite) => prerequisite.id === 'claude-auth',
    )?.status;
  try {
    await waitFor(() => expect(authStatus()).toBe('missing'));
    await waitFor(() =>
      expect(hook.result.current.login.data?.phase).toBe('awaiting-approval'),
    );
    // The person approves on the provider's page; the next poll completes.
    stationState.signedIn = true;
    phase = 'completed';
    await waitFor(() => expect(authStatus()).toBe('installed'), {
      timeout: 5_000,
    });
  } finally {
    hook.unmount();
    client.clear();
  }
});
