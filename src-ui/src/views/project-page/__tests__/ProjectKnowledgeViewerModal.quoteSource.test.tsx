/** @vitest-environment jsdom */

/**
 * "Open source conversation" from a quote OUTSIDE Chat: a knowledge document
 * rendered through `LazyMarkdown` → `MarkdownRenderer` → `QuoteSourceLink`,
 * the inspected source's enabled Open action, and the real region model and
 * navigation store behind it. The open must SHOW the conversation (Chat's
 * canonical reveal), not only point `?chat=` at it, and must not take a pane
 * with unsaved work off screen without asking it once. Only the source read
 * and the authority scope are stubbed.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { type ReactNode, useEffect } from 'react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import {
  LayoutChatPlacementContext,
  subscribeCenterChatPageRequests,
} from '../../../app-shell/chat-placement';
import { KeyboardShortcutsProvider } from '../../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../../contexts/NavigationContext';
import { navigationStore } from '../../../contexts/navigation-store';
import {
  RegionModelProvider,
  useRegionModel,
} from '../../../contexts/RegionModelContext';
import { deviceSettingsStore } from '../../../lib/device-settings-store';
import { quoteHref, type SavedAnswerQuote } from '../../../utils/answer-quotes';
import { ProjectKnowledgeViewerModal } from '../ProjectKnowledgeViewerModal';

const ORIGIN = 'http://station.test';
const scope = vi.hoisted(() => ({
  apiBase: 'http://station.test',
  current: true,
}));

vi.mock('../../../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../contexts/ApiBaseContext')
  >()),
  useHostRequestAuthorityScope: () => ({
    apiBase: scope.apiBase,
    authorityKey: 'authority-a',
    isCurrent: () => scope.current,
  }),
}));

vi.mock('@kontourai/station-sdk/quote-source', () => ({
  getAssistantQuoteSource: vi.fn(async () => ({
    version: 1,
    sessionId: 'session-a',
    turnId: 'turn-a',
    messageId: 'answer-a',
    text: 'The answer as it reads now.',
    revision: 'a'.repeat(64),
  })),
}));

const QUOTE: SavedAnswerQuote = {
  version: 1,
  origin: ORIGIN,
  sessionId: 'session-a',
  turnId: 'turn-a',
  messageId: 'answer-a',
  revision: 'a'.repeat(64),
  excerpt: 'The answer as it read then.',
};

let model: ReturnType<typeof useRegionModel> | null = null;
function RegionShellProbe() {
  const value = useRegionModel();
  // A region shell is mounted wherever the ambient dock is, which is what
  // makes a reveal a state write rather than a deep link.
  const register = value.registerRegionSurfaceHost;
  useEffect(() => register(), [register]);
  useEffect(() => {
    model = value;
  }, [value]);
  return null;
}

function mount(
  quote: SavedAnswerQuote = QUOTE,
  around?: (node: ReactNode) => ReactNode,
) {
  const content = `See [the reviewed answer](${quoteHref(quote)}) for why.`;
  const tree = (
    <RegionModelProvider>
      <RegionShellProbe />
      <ProjectKnowledgeViewerModal
        doc={{ filename: 'decisions.md', chunkCount: 1 } as never}
        content={content}
        loading={false}
        onClose={() => {}}
      />
    </RegionModelProvider>
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <KeyboardShortcutsProvider>
        <NavigationProvider>{around ? around(tree) : tree}</NavigationProvider>
      </KeyboardShortcutsProvider>
    </QueryClientProvider>,
  );
}

async function inspectAndOpen() {
  fireEvent.click(
    await screen.findByRole('button', { name: 'the reviewed answer' }),
  );
  const open = await screen.findByRole('button', {
    name: 'Open source conversation',
  });
  await waitFor(() => expect(model).not.toBeNull());
  act(() => fireEvent.click(open));
}

function params() {
  return new URLSearchParams(window.location.search);
}

// The renderer chunk `LazyMarkdown` loads: imported once here so the waits
// below measure rendering, not a cold import on a loaded host.
beforeAll(async () => {
  await import('../../../components/chat/MarkdownRenderer');
});

beforeEach(() => {
  model = null;
  scope.apiBase = ORIGIN;
  scope.current = true;
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1280,
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  window.history.replaceState({}, '', '/projects/station');
  navigationStore.navigate('/projects/station', {
    chat: null,
    dock: null,
    maximize: null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('Open source conversation from a knowledge document', () => {
  test('with the dock closed, it shows the conversation, not only names it', async () => {
    mount();
    await waitFor(() => expect(model?.regions.bottom.visible).toBe(false));
    await inspectAndOpen();
    await waitFor(() =>
      expect(model?.regions.bottom).toMatchObject({
        visible: true,
        occupant: 'chat',
      }),
    );
    expect(params().get('chat')).toBe('session-a');
    expect(window.location.pathname).toBe('/projects/station');
    expect(window.location.hash).toBe('#station-message=answer-a');
    expect(
      screen.queryByRole('dialog', { name: 'Quoted answer source' }),
    ).toBeNull();
  });

  test('a Chat already full screen stays full screen', async () => {
    navigationStore.navigate('/projects/station', {
      dock: 'open',
      maximize: 'true',
    });
    mount();
    await waitFor(() =>
      expect(model?.regions.bottom).toMatchObject({
        visible: true,
        maximized: true,
      }),
    );
    await inspectAndOpen();
    await waitFor(() => expect(params().get('chat')).toBe('session-a'));
    expect(model?.regions.bottom).toMatchObject({
      visible: true,
      maximized: true,
      occupant: 'chat',
    });
    expect(params().get('maximize')).toBe('true');
  });

  test('where the Coding centre owns Chat, its Chat page is asked for instead of the dock', async () => {
    const requests = vi.fn();
    const unsubscribe = subscribeCenterChatPageRequests(requests);
    try {
      mount(QUOTE, (tree) => (
        <LayoutChatPlacementContext.Provider value="center">
          {tree}
        </LayoutChatPlacementContext.Provider>
      ));
      await inspectAndOpen();
      await waitFor(() => expect(requests).toHaveBeenCalledTimes(1));
      expect(params().get('chat')).toBe('session-a');
      expect(model?.regions.bottom.visible).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  test('a pane with unsaved work that the reveal would hide is asked once; Cancel changes nothing', async () => {
    navigationStore.navigate('/projects/station', { dock: 'open' });
    mount();
    await waitFor(() => expect(model).not.toBeNull());
    act(() => model?.placeSurface('activity', 'bottom'));
    await waitFor(() =>
      expect(model?.regions.bottom).toMatchObject({
        visible: true,
        occupant: 'activity',
      }),
    );
    let answer: 'cancel' | 'continue' = 'cancel';
    const asked = vi.fn();
    const unregister = navigationStore.registerNavigationGuard(
      Symbol('activity draft'),
      (continueNavigation, cancel) => {
        asked();
        if (answer === 'cancel') cancel?.();
        else continueNavigation();
      },
      'activity',
    );
    try {
      const search = window.location.search;
      await inspectAndOpen();
      expect(asked).toHaveBeenCalledTimes(1);
      expect(window.location.search).toBe(search);
      expect(window.location.hash).toBe('');
      expect(model?.regions.bottom.occupant).toBe('activity');
      expect(
        screen.getByRole('dialog', { name: 'Quoted answer source' }),
      ).toBeTruthy();

      answer = 'continue';
      act(() =>
        fireEvent.click(
          screen.getByRole('button', { name: 'Open source conversation' }),
        ),
      );
      await waitFor(() => expect(model?.regions.bottom.occupant).toBe('chat'));
      expect(asked).toHaveBeenCalledTimes(2);
      expect(params().get('chat')).toBe('session-a');
      expect(window.location.hash).toBe('#station-message=answer-a');
    } finally {
      unregister();
    }
  });

  test('a Station that changes while a guard answers opens nothing', async () => {
    navigationStore.navigate('/projects/station', { dock: 'open' });
    mount();
    await waitFor(() => expect(model).not.toBeNull());
    act(() => model?.placeSurface('activity', 'bottom'));
    const unregister = navigationStore.registerNavigationGuard(
      Symbol('activity draft'),
      (continueNavigation) => {
        scope.current = false;
        continueNavigation();
      },
      'activity',
    );
    try {
      await inspectAndOpen();
      expect(params().get('chat')).toBeNull();
      expect(window.location.hash).toBe('');
      expect(model?.regions.bottom.occupant).toBe('activity');
    } finally {
      unregister();
    }
  });

  test('a quote from another Station offers no open, and a scope lost before the click opens nothing', async () => {
    mount({ ...QUOTE, origin: 'http://other-station.test' });
    fireEvent.click(
      await screen.findByRole('button', { name: 'the reviewed answer' }),
    );
    expect(await screen.findByText(/Select the original Station/)).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Open source conversation' }),
    ).toBeNull();
    cleanup();

    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'the reviewed answer' }),
    );
    const open = await screen.findByRole('button', {
      name: 'Open source conversation',
    });
    scope.current = false;
    act(() => fireEvent.click(open));
    expect(params().get('chat')).toBeNull();
    expect(window.location.hash).toBe('');
    expect(model?.regions.bottom.visible).toBe(false);
  });
});
