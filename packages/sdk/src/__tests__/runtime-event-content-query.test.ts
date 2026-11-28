// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { loadApprovalContent } from '../client/runtime-event-content.js';
import {
  approvalContentQueryKey,
  useApprovalContentQuery,
} from '../query-domains/runtimeEventContent';

vi.mock('../client/runtime-event-content.js');

describe('approval content query key', () => {
  test('changes when the references shown for the call change', () => {
    const base = {
      threadId: 't',
      requestId: 'r',
      requestEventId: 'e',
      shownRefs: [`sha256-${'a'.repeat(64)}`],
    };
    expect(approvalContentQueryKey(base)).not.toEqual(
      approvalContentQueryKey({
        ...base,
        shownRefs: [`sha256-${'b'.repeat(64)}`],
      }),
    );
    expect(approvalContentQueryKey(base)).not.toEqual(
      approvalContentQueryKey({ ...base, shownRefs: [] }),
    );
    expect(approvalContentQueryKey({ ...base, shownRefs: ['y', 'x'] })).toEqual(
      approvalContentQueryKey({ ...base, shownRefs: ['x', 'y'] }),
    );
  });
});

test('an approval refresh loads the new binding despite the original cached result', async () => {
  const read = vi.mocked(loadApprovalContent);
  read.mockImplementation(async () => {
    const version = read.mock.calls.length;
    return {
      binding: { required: true } as Awaited<
        ReturnType<typeof loadApprovalContent>
      >['binding'],
      request: { method: 'request.opened' } as Awaited<
        ReturnType<typeof loadApprovalContent>
      >['request'],
      bound: [],
      viewedContentDigest: `digest-${version}`,
    };
  });
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const input = {
    apiBase: 'http://station.test',
    threadId: 't',
    requestId: 'r',
    requestEventId: 'e',
  };
  const first = renderHook(() => useApprovalContentQuery(input), { wrapper });
  await waitFor(() =>
    expect(first.result.current.data?.viewedContentDigest).toBe('digest-1'),
  );
  first.unmount();

  const refreshed = renderHook(
    () => useApprovalContentQuery({ ...input, refreshVersion: 1 }),
    { wrapper },
  );
  expect(refreshed.result.current.data).toBeUndefined();
  await waitFor(() =>
    expect(refreshed.result.current.data?.viewedContentDigest).toBe('digest-2'),
  );
  expect(read).toHaveBeenCalledTimes(2);
});
