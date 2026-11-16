// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

/**
 * Whether agent feedback is offered: pending until the previews and the
 * host's capability answer, so Project settings keeps a link to its Agent
 * feedback section instead of dropping it while they load.
 */

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'k',
    isCurrent: () => true,
  }),
}));
const previews = vi.hoisted(() => ({
  value: { isPending: true, data: undefined } as {
    isPending: boolean;
    data?: Array<{ id: string; enabled: boolean }>;
  },
}));
vi.mock('@kontourai/station-sdk', () => ({
  useFeaturePreviewsQuery: () => previews.value,
}));
vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () =>
    new Set(
      (previews.value.data ?? [])
        .filter((preview) => preview.enabled)
        .map((preview) => preview.id),
    ),
}));
vi.mock('@kontourai/station-sdk/pull-request-feedback', () => ({
  readPullRequestFeedbackCapability: vi.fn(async () => true),
}));

import { usePullRequestFeedbackAvailable } from '../usePullRequestFeedbackAvailable';

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    {children}
  </QueryClientProvider>
);
afterEach(cleanup);

describe('usePullRequestFeedbackAvailable', () => {
  test('is pending while the previews have not answered', () => {
    previews.value = { isPending: true, data: undefined };
    const { result } = renderHook(() => usePullRequestFeedbackAvailable(), {
      wrapper,
    });
    expect(result.current).toEqual({ available: false, pending: true });
  });

  test('is available once the preview is on and the host serves it', async () => {
    previews.value = {
      isPending: false,
      data: [{ id: 'pull-request-agent-feedback', enabled: true }],
    };
    const { result } = renderHook(() => usePullRequestFeedbackAvailable(), {
      wrapper,
    });
    await waitFor(() =>
      expect(result.current).toEqual({ available: true, pending: false }),
    );
  });

  test('is neither once the previews say it is off', () => {
    previews.value = { isPending: false, data: [] };
    const { result } = renderHook(() => usePullRequestFeedbackAvailable(), {
      wrapper,
    });
    expect(result.current).toEqual({ available: false, pending: false });
  });
});
