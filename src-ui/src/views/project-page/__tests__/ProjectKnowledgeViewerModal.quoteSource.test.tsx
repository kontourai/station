/** @vitest-environment jsdom */

/**
 * "Open source conversation" from a quote OUTSIDE Chat: a knowledge document
 * rendered through `LazyMarkdown` → `MarkdownRenderer` → `QuoteSourceLink`,
 * the inspected source's enabled Open action, and the real region model and
 * navigation store behind it. The open must SHOW the conversation (Chat's
 * canonical reveal), not only point `?chat=` at it, and must not take a pane
 * with unsaved work off screen without asking it once. An admitted open
 * closes the document through its owner, so it does not stay over Chat; one
 * refused or cancelled leaves the document and the inspection as they were.
 * Only the source read and the authority scope are stubbed.
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
import { type ReactNode, useEffect, useState } from 'react';
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
import { MOBILE_MEDIA_QUERY } from '../../../hooks/useIsMobile';
import { deviceSettingsStore } from '../../../lib/device-settings-store';
import { quoteHref, type SavedAnswerQuote } from '../../../utils/answer-quotes';
import { ProjectKnowledgeViewerModal } from '../ProjectKnowledgeViewerModal';
import type { DocMeta } from '../types';

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

const DOC: DocMeta = {
  id: 'doc-decisions',
  filename: 'decisions.md',
  chunkCount: 1,
  createdAt: '2026-10-19T00:00:00.000Z',
};

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
function RegionShellProbe({ regionShell }: { regionShell: boolean }) {
  const value = useRegionModel();
  // A region shell is mounted wherever the ambient dock is, which is what
  // makes a reveal a state write rather than a deep link.
  const register = value.registerRegionSurfaceHost;
  useEffect(
    () => (regionShell ? register() : undefined),
    [register, regionShell],
  );
  useEffect(() => {
    model = value;
  }, [value]);
  return null;
}

/** The modal's own `loading` state, which a test sets to take the quote away. */
const modalHost = {
  setLoading: null as ((loading: boolean) => void) | null,
};
/** Owned as `ProjectKnowledgeSection` owns it: its close takes it away. */
function KnowledgeModal({ content }: { content: string }) {
  const [viewing, setViewing] = useState(true);
  const [loading, setLoading] = useState(false);
  modalHost.setLoading = setLoading;
  return viewing ? (
    <ProjectKnowledgeViewerModal
      doc={DOC}
      content={content}
      loading={loading}
      onClose={() => setViewing(false)}
    />
  ) : null;
}

function knowledgeDocument() {
  return screen.queryByRole('button', { name: 'Close knowledge document' });
}

function mount(
  quote: SavedAnswerQuote = QUOTE,
  around?: (node: ReactNode) => ReactNode,
  { regionShell = true }: { regionShell?: boolean } = {},
) {
  const content = `See [the reviewed answer](${quoteHref(quote)}) for why.`;
  const tree = (
    <RegionModelProvider>
      <RegionShellProbe regionShell={regionShell} />
      <KnowledgeModal content={content} />
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

function stubPhone() {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 390,
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === MOBILE_MEDIA_QUERY || query === '(pointer: coarse)',
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

/**
 * An unsaved-changes guard for `owner` that answers LATER, as a person
 * reading a prompt does: the test holds the answer and gives it.
 */
function deferredGuard(owner: string) {
  const asked = vi.fn();
  let pending: { proceed: () => void; cancel?: () => void } | null = null;
  const unregister = navigationStore.registerNavigationGuard(
    Symbol(`${owner} draft`),
    (proceed, cancel) => {
      asked();
      pending = { proceed, cancel };
    },
    owner,
  );
  const answer = (choice: 'proceed' | 'cancel') =>
    act(() => {
      const current = pending;
      pending = null;
      if (choice === 'proceed') current?.proceed();
      else current?.cancel?.();
    });
  return { asked, answer, unregister };
}

// The renderer chunk `LazyMarkdown` loads: imported once here so the waits
// below measure rendering, not a cold import on a loaded host.
beforeAll(async () => {
  await import('../../../components/chat/MarkdownRenderer');
});

beforeEach(() => {
  model = null;
  modalHost.setLoading = null;
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
    // The document it was read in does not stay over the conversation.
    expect(knowledgeDocument()).toBeNull();
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
    expect(knowledgeDocument()).toBeNull();
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
      expect(knowledgeDocument()).toBeNull();
    } finally {
      unsubscribe();
    }
  });

  // A Chat workspace layout owns the viewport and mounts no region shell, so
  // the reveal's fallback is a deep link to `/` — which would leave the very
  // layout Chat is shown in. Selecting the conversation is enough there.
  test('where a Chat layout owns the viewport, it selects the conversation and stays on the layout', async () => {
    window.history.replaceState({}, '', '/projects/station/layouts/chat');
    navigationStore.navigate('/projects/station/layouts/chat', {
      chat: null,
    });
    mount(
      QUOTE,
      (tree) => (
        <LayoutChatPlacementContext.Provider value="viewport">
          {tree}
        </LayoutChatPlacementContext.Provider>
      ),
      { regionShell: false },
    );
    await inspectAndOpen();
    await waitFor(() => expect(params().get('chat')).toBe('session-a'));
    expect(window.location.pathname).toBe('/projects/station/layouts/chat');
    expect(params().get('surface')).toBeNull();
    expect(window.location.hash).toBe('#station-message=answer-a');
    expect(knowledgeDocument()).toBeNull();
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
      expect(knowledgeDocument()).not.toBeNull();

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
      expect(knowledgeDocument()).toBeNull();
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
      expect(
        screen.getByRole('dialog', { name: 'Quoted answer source' }),
      ).toBeTruthy();
      expect(knowledgeDocument()).not.toBeNull();
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
    expect(knowledgeDocument()).not.toBeNull();
  });

  test('on a phone, the pane a layer shows over Chat is asked once, and Continue shows the conversation', async () => {
    stubPhone();
    navigationStore.navigate('/projects/station', { dock: 'open' });
    mount();
    await waitFor(() => expect(model).not.toBeNull());
    act(() => {
      model?.openSurfaceInRegion('activity');
    });
    await waitFor(() =>
      expect(model?.phoneLayer).toMatchObject({ surfaceId: 'activity' }),
    );
    const guard = deferredGuard('activity');
    try {
      const search = window.location.search;
      await inspectAndOpen();
      expect(guard.asked).toHaveBeenCalledTimes(1);
      // Asked, not acted on: the layer and the URL wait for the answer.
      expect(model?.phoneLayer).toMatchObject({ surfaceId: 'activity' });
      expect(window.location.search).toBe(search);
      guard.answer('proceed');
      await waitFor(() => expect(model?.phoneLayer).toBeNull());
      expect(model?.regions.bottom.occupant).toBe('chat');
      expect(params().get('chat')).toBe('session-a');
      expect(window.location.hash).toBe('#station-message=answer-a');
      expect(guard.asked).toHaveBeenCalledTimes(1);
      expect(knowledgeDocument()).toBeNull();
    } finally {
      guard.unregister();
    }
  });

  test('on a phone, a Station lost while the layer’s guard is up changes nothing', async () => {
    stubPhone();
    navigationStore.navigate('/projects/station', { dock: 'open' });
    mount();
    await waitFor(() => expect(model).not.toBeNull());
    act(() => {
      model?.openSurfaceInRegion('activity');
    });
    await waitFor(() =>
      expect(model?.phoneLayer).toMatchObject({ surfaceId: 'activity' }),
    );
    const guard = deferredGuard('activity');
    try {
      const search = window.location.search;
      const arrangement = structuredClone(model?.regions);
      await inspectAndOpen();
      scope.current = false;
      guard.answer('proceed');
      expect(model?.phoneLayer).toMatchObject({ surfaceId: 'activity' });
      expect(model?.regions).toEqual(arrangement);
      expect(window.location.search).toBe(search);
      expect(window.location.hash).toBe('');
      expect(
        screen.getByRole('dialog', { name: 'Quoted answer source' }),
      ).toBeTruthy();
      expect(knowledgeDocument()).not.toBeNull();
    } finally {
      guard.unregister();
    }
  });

  // Navigation's own guard generation revokes an admission when a guard is
  // registered while it waits; here, for the panes this open would hide.
  test('a guard registered for the asked pane while its question is open is never bypassed', async () => {
    navigationStore.navigate('/projects/station', { dock: 'open' });
    mount();
    await waitFor(() => expect(model).not.toBeNull());
    act(() => model?.placeSurface('activity', 'bottom'));
    const first = deferredGuard('activity');
    let second: ReturnType<typeof deferredGuard> | null = null;
    try {
      const search = window.location.search;
      await inspectAndOpen();
      expect(first.asked).toHaveBeenCalledTimes(1);
      // More unsaved work in Activity while the first question is open.
      second = deferredGuard('activity');
      first.answer('proceed');
      expect(second.asked).not.toHaveBeenCalled();
      expect(model?.regions.bottom.occupant).toBe('activity');
      expect(window.location.search).toBe(search);
      expect(window.location.hash).toBe('');
      expect(
        screen.getByRole('dialog', { name: 'Quoted answer source' }),
      ).toBeTruthy();
    } finally {
      first.unregister();
      second?.unregister();
    }
  });

  // The arrangement a guard's own callback changed is not rendered yet when
  // it answers in the same event: the prediction reads what the model
  // committed, which is what the reveal starts from.
  test('a pane a guard moved in before answering, unrendered, is not hidden unasked', async () => {
    navigationStore.navigate('/projects/station', { dock: 'open' });
    mount();
    await waitFor(() => expect(model).not.toBeNull());
    act(() => model?.placeSurface('activity', 'bottom'));
    const agents = deferredGuard('workspace-agents');
    const unregister = navigationStore.registerNavigationGuard(
      Symbol('activity answers at once'),
      (proceed) => {
        model?.placeSurface('workspace-agents', 'bottom');
        proceed();
      },
      'activity',
    );
    try {
      const search = window.location.search;
      await inspectAndOpen();
      expect(agents.asked).not.toHaveBeenCalled();
      expect(model?.regions.bottom.occupant).toBe('workspace-agents');
      expect(window.location.search).toBe(search);
      expect(window.location.hash).toBe('');
    } finally {
      unregister();
      agents.unregister();
    }
  });

  test('a request whose quote went away while a guard waited opens nothing', async () => {
    navigationStore.navigate('/projects/station', { dock: 'open' });
    mount();
    await waitFor(() => expect(model).not.toBeNull());
    act(() => model?.placeSurface('activity', 'bottom'));
    const guard = deferredGuard('activity');
    try {
      const search = window.location.search;
      await inspectAndOpen();
      act(() => modalHost.setLoading?.(true));
      expect(
        screen.queryByRole('dialog', { name: 'Quoted answer source' }),
      ).toBeNull();
      guard.answer('proceed');
      expect(model?.regions.bottom.occupant).toBe('activity');
      expect(window.location.search).toBe(search);
      expect(window.location.hash).toBe('');
    } finally {
      guard.unregister();
    }
  });

  test('a covered pane replaced by another unsaved one while its guard is up opens nothing', async () => {
    navigationStore.navigate('/projects/station', { dock: 'open' });
    mount();
    await waitFor(() => expect(model).not.toBeNull());
    act(() => model?.placeSurface('activity', 'bottom'));
    const first = deferredGuard('activity');
    const second = deferredGuard('workspace-agents');
    try {
      await inspectAndOpen();
      expect(first.asked).toHaveBeenCalledTimes(1);
      // While Activity's prompt is up, the reader puts Agents — with its own
      // unsaved work — where Activity was.
      act(() => model?.placeSurface('workspace-agents', 'bottom'));
      await waitFor(() =>
        expect(model?.regions.bottom.occupant).toBe('workspace-agents'),
      );
      first.answer('proceed');
      expect(second.asked).not.toHaveBeenCalled();
      expect(model?.regions.bottom.occupant).toBe('workspace-agents');
      expect(params().get('chat')).toBeNull();
      expect(window.location.hash).toBe('');
    } finally {
      first.unregister();
      second.unregister();
    }
  });
});
