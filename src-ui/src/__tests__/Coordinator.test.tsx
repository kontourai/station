// @vitest-environment jsdom
/**
 * #3628: the person's coordinator on Home and in a chat's More menu, as the
 * real components over the real hook. Only the network is stubbed, answering
 * the envelopes the coordinator routes produce.
 */
import type {
  CoordinatorDelivery,
  CoordinatorDesignation,
} from '@kontourai/station-contracts/coordinator';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useCoordinatorDockActions } from '../components/chat-dock/useCoordinatorDockActions';
import { HomeCoordinatorCard } from '../components/home/HomeCoordinatorCard';
import { COORDINATOR_PRODUCT_NAME } from '../lib/productNames';

const picturePreview = vi.hoisted(() => ({ enabled: false }));
vi.mock('../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () =>
    new Set(picturePreview.enabled ? ['coordinator-picture'] : []),
}));
const API = 'http://station.test';
const authority = vi.hoisted(() => ({
  current: {
    apiBase: 'http://station.test',
    authorityKey: 'device-a',
    requiresEnrolledCredential: false,
    isCurrent: (): boolean => true,
  },
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => authority.current,
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate }),
}));
const showToast = vi.hoisted(() => vi.fn());
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast }),
}));

let designation: CoordinatorDesignation | null;
let delivery: CoordinatorDelivery | undefined;
let status: number;
let calls: Array<{ method: string; body?: unknown }>;

beforeEach(() => {
  designation = null;
  delivery = undefined;
  picturePreview.enabled = false;
  status = 200;
  showToast.mockReset();
  calls = [];
  navigate.mockReset();
  setClientCredentialResolver(() => ({
    origin: authority.current.apiBase,
    requestAuthority: authority.current,
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? 'GET';
      const body =
        typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, ...(body ? { body } : {}) });
      if (url === `${API}/api/orchestration/coordinator/picture`)
        return Response.json({
          success: true,
          data: {
            items: [
              {
                conversationId: 'work-a',
                status: 'waiting',
                summary: 'Needs review',
                updatedAt: 10,
              },
            ],
          },
        });
      if (url !== `${API}/api/orchestration/coordinator`)
        return Response.json({ success: false }, { status: 404 });
      if (status !== 200)
        return Response.json(
          { success: false, code: 'coordinator_unavailable' },
          { status },
        );
      if (method === 'PUT') {
        if (designation && !body.replace)
          return Response.json(
            { success: false, code: 'coordinator_already_designated' },
            { status: 409 },
          );
        designation = {
          conversationId: body.conversationId,
          designatedAt: '2026-10-28T09:00:00.000Z',
        };
        return Response.json({
          success: true,
          data: { designation, ...(delivery ? { delivery } : {}) },
        });
      }
      if (method === 'DELETE') {
        designation = null;
        return Response.json({ success: true, data: { undesignated: true } });
      }
      return Response.json({
        success: true,
        data: {
          designation,
          ...(designation && delivery ? { delivery } : {}),
        },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
});

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('Home coordinator card', () => {
  test('shows the readable working picture when its preview is enabled', async () => {
    picturePreview.enabled = true;
    designation = {
      conversationId: 'chat-houston',
      designatedAt: '2026-10-28T09:00:00.000Z',
    };
    render(<HomeCoordinatorCard />, { wrapper: wrapper() });
    expect(await screen.findByText('Needs review')).toBeTruthy();
    expect(screen.getByText('Waiting on you')).toBeTruthy();
  });

  test('pins the coordinator with one action that opens its chat', async () => {
    designation = {
      conversationId: 'chat-houston',
      designatedAt: '2026-10-28T09:00:00.000Z',
    };
    render(<HomeCoordinatorCard />, { wrapper: wrapper() });
    const open = await screen.findByRole('button', {
      name: `Talk to ${COORDINATOR_PRODUCT_NAME}`,
    });
    expect(
      screen.getByRole('heading', { name: COORDINATOR_PRODUCT_NAME }),
    ).toBeTruthy();
    fireEvent.click(open);
    expect(navigate).toHaveBeenCalledWith('/', {
      chat: 'chat-houston',
      dock: 'open',
    });
  });

  test('without one, it says where to make one', async () => {
    render(<HomeCoordinatorCard />, { wrapper: wrapper() });
    expect(
      await screen.findByText(
        `Open a chat and choose Make this ${COORDINATOR_PRODUCT_NAME} from its menu.`,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  test.each([404, 503])(
    'a host answering %s (older, or hosted) shows nothing',
    async (code) => {
      status = code;
      const { container } = render(<HomeCoordinatorCard />, {
        wrapper: wrapper(),
      });
      await waitFor(() => expect(calls).toHaveLength(1));
      await waitFor(() => expect(container.innerHTML).toBe(''));
    },
  );
});

describe('chat More-menu coordinator rows', () => {
  test('makes the chat the coordinator, then offers to stop', async () => {
    const { result } = renderHook(() => useCoordinatorDockActions('chat-a'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]!.label).toBe(
      `Make this ${COORDINATOR_PRODUCT_NAME}`,
    );
    result.current[0]!.onSelect(document.createElement('button'));
    await waitFor(() =>
      expect(result.current[0]?.label).toBe(
        `Stop using as ${COORDINATOR_PRODUCT_NAME}`,
      ),
    );
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
      conversationId: 'chat-a',
    });
  });

  test('another chat being the coordinator is an explicit replace', async () => {
    designation = {
      conversationId: 'chat-old',
      designatedAt: '2026-10-28T09:00:00.000Z',
    };
    const { result } = renderHook(() => useCoordinatorDockActions('chat-new'), {
      wrapper: wrapper(),
    });
    await waitFor(() =>
      expect(result.current[0]?.label).toBe(
        `Make this ${COORDINATOR_PRODUCT_NAME} instead`,
      ),
    );
    result.current[0]!.onSelect(document.createElement('button'));
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
        conversationId: 'chat-new',
        replace: true,
      }),
    );
  });
});

describe('what the person is told about delivery', () => {
  const houston = {
    conversationId: 'chat-houston',
    designatedAt: '2026-10-28T09:00:00.000Z',
  };

  test.each([
    [
      { wakes: 'blocked', toolsPending: false, engine: 'codex' },
      "Updates can't reach this chat yet: its engine doesn't report when a turn ends.",
    ],
    [
      { wakes: 'ready', toolsPending: true },
      'It hears when your work needs you. Station tools arrive with its next session.',
    ],
    [
      { wakes: 'ready', toolsPending: false },
      'Your personal agent. It hears when your work needs you.',
    ],
  ] as const)('the card states %o', async (state, line) => {
    designation = houston;
    delivery = state;
    render(<HomeCoordinatorCard />, { wrapper: wrapper() });
    expect(await screen.findByText(line)).toBeTruthy();
  });

  test('designating a running chat says its tools arrive with the next session', async () => {
    delivery = { wakes: 'ready', toolsPending: true };
    const { result } = renderHook(() => useCoordinatorDockActions('chat-a'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current).toHaveLength(1));
    result.current[0]!.onSelect(document.createElement('button'));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        `This chat is ${COORDINATOR_PRODUCT_NAME}. It hears when your work needs you. Station tools arrive with its next session.`,
        undefined,
        undefined,
        undefined,
        'success',
      ),
    );
  });

  test('a refused designation is told, not silent', async () => {
    const { result } = renderHook(() => useCoordinatorDockActions('chat-a'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current).toHaveLength(1));
    // Another device designated a chat in the meantime.
    designation = houston;
    result.current[0]!.onSelect(document.createElement('button'));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        `Another chat is ${COORDINATOR_PRODUCT_NAME}. Reopen this menu to replace it.`,
        undefined,
        undefined,
        undefined,
        'error',
      ),
    );
  });
});
