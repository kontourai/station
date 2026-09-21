/** @vitest-environment jsdom */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { _setApiBase } from '../api-core';
import type { DelegatedTaskHandle } from '../client/delegations';
import {
  type ClientCredential,
  StationRequestAuthorityError,
  setClientCredentialResolver,
} from '../client/http';
import {
  delegateOrchestrationTask,
  useDelegateOrchestrationTaskMutation,
} from '../query-domains/chatRuntimeOrchestration';

const HOME_A = 'https://home-a.example.test';
const AUTHORITY_A = 'authority-key-A';
const AUTHORITY_B = 'authority-key-B';
const HOME_B = 'https://home-b.example.test';
const DELEGATIONS_PATH = '/api/orchestration/delegations';

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

function delegationSuccess(): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data: {
        taskId: 'task:1',
        sessionId: 'task:1',
        status: 'dispatched',
        environment: { id: 'current', name: 'This Station', kind: 'current' },
        target: { kind: 'agent', id: 'codex' },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function deferredFetch() {
  let release!: (response: Response) => void;
  const gate = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fetchMock = vi.fn<typeof fetch>(() => gate);
  return { fetchMock, release };
}

function authorityRecord(
  origin: string,
  authorityKey: string,
  isCurrent: () => boolean,
  credential = 'sdk-test-credential-not-for-production',
): ClientCredential {
  return {
    origin,
    credential,
    requestAuthority: { apiBase: origin, authorityKey, isCurrent },
  };
}

afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

describe('delegateOrchestrationTask per-invocation authority (#480 review)', () => {
  test('a per-invocation apiBase dispatches verbatim without consulting ambient state', async () => {
    _setApiBase('https://ambient.example.test');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(delegationSuccess());
    vi.stubGlobal('fetch', fetchMock);

    const handle = await delegateOrchestrationTask({
      prompt: 'Ship it',
      target: { environment: { kind: 'current' }, agent: agentId('codex') },
      parentTaskId: 'parent:1',
      apiBase: 'https://invocation.example.test',
    });

    expect(handle.taskId).toBe('task:1');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body?: unknown },
    ];
    expect(url).toBe(`https://invocation.example.test${DELEGATIONS_PATH}`);
    // The public body is exactly the delegation contract: no client scope,
    // no address, no functions cross into it.
    expect(JSON.parse(String(init.body))).toEqual({
      prompt: 'Ship it',
      target: { environment: { kind: 'current' }, agent: 'codex' },
      parentTaskId: 'parent:1',
    });
  });

  test('a same-origin credential rotation across resolution sends no wrong-authority POST', async () => {
    let resolveCredential!: (record: ClientCredential | undefined) => void;
    const credentialGate = new Promise<ClientCredential | undefined>(
      (resolve) => {
        resolveCredential = resolve;
      },
    );
    const resolver = vi.fn(() => credentialGate);
    setClientCredentialResolver(resolver);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(delegationSuccess());
    vi.stubGlobal('fetch', fetchMock);

    let rotated = false;
    const pending = delegateOrchestrationTask(
      {
        prompt: 'Ship it',
        target: { environment: { kind: 'current' }, agent: agentId('codex') },
        apiBase: HOME_A,
      },
      { requestScope: { apiBase: HOME_A, authorityKey: AUTHORITY_A } },
    );
    // The rotation lands while credential resolution is still in flight, so
    // the resolver settles the OLD record against a moved authority.
    await vi.waitFor(() => expect(resolver).toHaveBeenCalled());
    rotated = true;
    resolveCredential(authorityRecord(HOME_A, AUTHORITY_A, () => !rotated));

    await expect(pending).rejects.toBeInstanceOf(StationRequestAuthorityError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a Home rotation across resolution sends no POST to either authority', async () => {
    let resolveCredential!: (record: ClientCredential | undefined) => void;
    const credentialGate = new Promise<ClientCredential | undefined>(
      (resolve) => {
        resolveCredential = resolve;
      },
    );
    const resolver = vi.fn(() => credentialGate);
    setClientCredentialResolver(resolver);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(delegationSuccess());
    vi.stubGlobal('fetch', fetchMock);

    const pending = delegateOrchestrationTask(
      {
        prompt: 'Ship it',
        target: { environment: { kind: 'current' }, agent: agentId('codex') },
        apiBase: HOME_A,
      },
      { requestScope: { apiBase: HOME_A, authorityKey: AUTHORITY_A } },
    );
    await vi.waitFor(() => expect(resolver).toHaveBeenCalled());
    // Rotation won the race: the resolver now settles a DIFFERENT Home.
    resolveCredential(authorityRecord(HOME_B, AUTHORITY_B, () => true));

    await expect(pending).rejects.toBeInstanceOf(StationRequestAuthorityError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a matching authority dispatches exactly once under its own credential', async () => {
    setClientCredentialResolver(() =>
      authorityRecord(HOME_A, AUTHORITY_A, () => true, 'home-a-credential'),
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(delegationSuccess());
    vi.stubGlobal('fetch', fetchMock);

    const handle = await delegateOrchestrationTask(
      {
        prompt: 'Ship it',
        target: { environment: { kind: 'current' }, agent: agentId('codex') },
        apiBase: HOME_A,
      },
      { requestScope: { apiBase: HOME_A, authorityKey: AUTHORITY_A } },
    );

    expect(handle.taskId).toBe('task:1');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers?: unknown; body?: unknown },
    ];
    expect(url).toBe(`${HOME_A}${DELEGATIONS_PATH}`);
    expect(new Headers(init.headers as HeadersInit).get('Authorization')).toBe(
      'Bearer home-a-credential',
    );
    expect(JSON.parse(String(init.body))).toEqual({
      prompt: 'Ship it',
      target: { environment: { kind: 'current' }, agent: 'codex' },
    });
  });

  test('the legacy published input shape still dispatches against the hook default', async () => {
    _setApiBase('https://ambient-legacy.example.test');
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(delegationSuccess());
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(
      () => useDelegateOrchestrationTaskMutation(HOME_A),
      { wrapper: wrapperFor(client) },
    );
    // EXACTLY the pre-#480 call shape: a bare DelegateTaskInput, no envelope.
    const handle = await result.current.mutateAsync({
      prompt: 'Ship it legacy',
      target: { environment: { kind: 'current' }, agent: agentId('codex') },
    });

    expect(handle.taskId).toBe('task:1');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body?: unknown },
    ];
    // Old behavior preserved: hook apiBase default, ambient authority, and
    // the public body is the input itself.
    expect(url).toBe(`${HOME_A}${DELEGATIONS_PATH}`);
    expect(JSON.parse(String(init.body))).toEqual({
      prompt: 'Ship it legacy',
      target: { environment: { kind: 'current' }, agent: 'codex' },
    });
  });

  test('the mutation honors per-invocation transport over later hook options', async () => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    setClientCredentialResolver(() =>
      authorityRecord(HOME_A, AUTHORITY_A, () => true, 'home-a-credential'),
    );
    const { fetchMock, release } = deferredFetch();
    vi.stubGlobal('fetch', fetchMock);

    const { result, rerender } = renderHook(
      ({ hookApiBase }: { hookApiBase: string }) =>
        useDelegateOrchestrationTaskMutation(hookApiBase),
      {
        wrapper: wrapperFor(client),
        initialProps: { hookApiBase: 'https://hook-default.example.test' },
      },
    );
    let pending!: Promise<DelegatedTaskHandle>;
    act(() => {
      pending = result.current.mutateAsync({
        input: {
          prompt: 'Ship it',
          target: {
            environment: { kind: 'current' },
            agent: agentId('codex'),
          },
        },
        apiBase: HOME_A,
        requestScope: { apiBase: HOME_A, authorityKey: AUTHORITY_A },
      });
    });
    // Hook options rotate while the dispatch is in flight: the invocation
    // must not follow them.
    rerender({ hookApiBase: 'https://rotated.example.test' });
    release(delegationSuccess());

    const handle = await pending;
    expect(handle.taskId).toBe('task:1');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${HOME_A}${DELEGATIONS_PATH}`);
  });
});
