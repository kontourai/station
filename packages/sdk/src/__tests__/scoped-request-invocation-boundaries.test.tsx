// @vitest-environment jsdom
import { encodeTaskToolResultReference } from '@kontourai/station-contracts';
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import * as React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  type ClientCredential,
  getJson,
  setClientCredentialResolver,
} from '../client/http';
import { useAttachTaskToolResultReferenceMutation } from '../task-tool-results';

afterEach(() => {
  cleanup();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});
const scopeA = {
  apiBase: 'http://same-station.test',
  authorityKey: 'authority-a',
};
const scopeB = {
  apiBase: 'http://same-station.test',
  authorityKey: 'authority-b',
};
const canonicalLink = {
  id: 'link-a',
  sourceType: 'task',
  sourceId: 'task-a',
  targetType: 'tool_result',
  targetId: encodeTaskToolResultReference('session-a', 'event-a'),
  relationType: 'references_tool_result',
  source: 'user',
  confidence: 1,
  createdAt: '2026-08-26T00:00:00.000Z',
};
const available = () =>
  new Response(JSON.stringify({ success: true, data: canonicalLink }));

test('expected request authority is snapshotted before an asynchronous credential resolver', async () => {
  const expected = { ...scopeA };
  let release!: (value: ClientCredential) => void;
  setClientCredentialResolver(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(available());
  vi.stubGlobal('fetch', fetch);
  const pending = getJson(`${scopeA.apiBase}/api/tasks/task-a`, {
    requestScope: expected,
  }).then(
    () => 'published',
    () => 'withheld',
  );
  expected.authorityKey = scopeB.authorityKey;
  release({
    origin: scopeB.apiBase,
    requestAuthority: { ...scopeB, isCurrent: () => true },
  });
  expect(await pending).toBe('withheld');
  expect(fetch).not.toHaveBeenCalled();
});

test('a cloned scoped response cannot bypass the current-authority body guard', async () => {
  let current = true;
  setClientCredentialResolver(() => ({
    origin: scopeA.apiBase,
    requestAuthority: { ...scopeA, isCurrent: () => current },
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>().mockResolvedValue(available()),
  );
  const response = await getJson(`${scopeA.apiBase}/api/tasks/task-a`, {
    requestScope: scopeA,
  });
  const clone = response.clone();
  current = false;
  await expect(clone.json()).rejects.toThrow();
});

test('a global mutation scheduling delay cannot rebind an invocation or its callbacks to a later scope', async () => {
  let active = scopeA;
  setClientCredentialResolver(() => {
    const captured = active;
    return {
      origin: captured.apiBase,
      requestAuthority: { ...captured, isCurrent: () => active === captured },
    };
  });
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(available());
  vi.stubGlobal('fetch', fetch);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = new QueryClient({
    mutationCache: new MutationCache({
      onMutate: async () => {
        entered();
        await blocked;
      },
    }),
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  const oldError = vi.fn();
  const newError = vi.fn();
  const oldSuccess = vi.fn();
  const newSuccess = vi.fn();
  const observer = renderHook(
    ({ requestScope, onError, onSuccess }) =>
      useAttachTaskToolResultReferenceMutation({
        requestScope,
        onError,
        onSuccess,
      }),
    {
      wrapper,
      initialProps: {
        requestScope: scopeA,
        onError: oldError,
        onSuccess: oldSuccess,
      },
    },
  );
  let pending!: Promise<string>;
  await act(async () => {
    pending = observer.result.current
      .mutateAsync({
        taskId: 'task-a',
        sessionId: 'session-a',
        eventId: 'event-a',
      })
      .then(
        () => 'published',
        () => 'withheld',
      );
    await started;
  });
  active = scopeB;
  observer.rerender({
    requestScope: scopeB,
    onError: newError,
    onSuccess: newSuccess,
  });
  await act(async () => {
    release();
    await pending;
  });
  expect(await pending).toBe('withheld');
  expect(fetch).not.toHaveBeenCalled();
  expect(newSuccess).not.toHaveBeenCalled();
  expect(newError).not.toHaveBeenCalled();
  expect(oldSuccess).not.toHaveBeenCalled();
  expect(oldError).toHaveBeenCalledOnce();
  observer.unmount();
  client.clear();
});
