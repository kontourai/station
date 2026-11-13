import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
// @vitest-environment jsdom
import type {
  ChildWorkItem,
  ChildWorkTranscriptEntry,
} from '@kontourai/station-contracts/child-work';
import { useChildWorkTranscriptQuery } from '@kontourai/station-sdk';
import { chromium } from '@playwright/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { createUiModuleGraph } from '../../../scripts/lib/ui-module-graph.mjs';
import {
  assertNoImportsSurvive,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';
import { SubagentTranscriptCard } from '../components/chat/SubagentTranscriptCard';
import { ChatDockHeader } from '../components/chat-dock/ChatDockHeader';
import { ChildChatNavigation } from '../components/chat-dock/ChildChatNavigation';
import type { ChildChatController } from '../components/chat-dock/ChildChatNavigationContext';
import {
  childChatTarget,
  useChildChatNavigation,
} from '../components/chat-dock/ChildChatNavigationContext';
import { ConversationConnectionProvider } from '../components/conversation/ConversationConnectionContext';
import { childWorkGlobalStore } from '../contexts/child-work-global-store';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { PreviewProvider } from '../contexts/PreviewContext';
import { RegionChromeSlotsContext } from '../workspace-panes/RegionChromeSlots';

vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
}));
vi.mock('../components/chat/ChatEmptyState', () => ({
  ChatEmptyState: () => (
    <p data-testid="initial-chat-empty">Initial chat state</p>
  ),
}));
vi.mock('../components/chat/ChildWorkInstructionPanel', () => ({
  ChildWorkInstructionPanel: () => null,
}));
const history = vi.hoisted(() => ({
  entries: [
    { kind: 'text', message: 0, role: 'user', text: 'Inspect the child files' },
    {
      kind: 'text',
      message: 1,
      role: 'assistant',
      text: '## Child answer\n\nThe files are ready.',
    },
  ] as ChildWorkTranscriptEntry[],
  error: undefined as Error | undefined,
  refetch: vi.fn(),
  sessions: [] as { threadId: string; childWork: { asChild: ChildWorkItem } }[],
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useOrchestrationSessionsQuery: () => ({
    data: history.sessions,
    isSuccess: true,
  }),
  useChildWorkTranscriptQuery: vi.fn(() => ({
    data: { pages: [{ entries: history.entries }] },
    isSuccess: !history.error,
    isPending: false,
    isError: Boolean(history.error),
    error: history.error,
    refetch: history.refetch,
    hasNextPage: false,
  })),
}));
vi.mock('../components/conversation/ConversationReader', () => ({
  SessionConversationReader: ({ isStreaming }: { isStreaming: boolean }) => (
    <output aria-label="Delegate state">
      {isStreaming ? 'running' : 'settled'}
    </output>
  ),
}));
const initialEntries = history.entries;
afterEach(() => {
  cleanup();
  childWorkGlobalStore.reset();
  history.sessions = [];
  history.entries = initialEntries;
  history.error = undefined;
  history.refetch.mockClear();
});
const connection = { apiBase: 'https://station.test' };
const item: ChildWorkItem = {
  producer: 'engine-subagent',
  reporterThreadId: 'parent',
  childId: 'child',
  status: 'completed',
  title: 'Review files',
  transcript: { kind: 'codex-thread', threadId: 'child' },
} as ChildWorkItem;
function Nested() {
  const open = useChildChatNavigation();
  return (
    <button
      type="button"
      onClick={() =>
        open?.(
          childChatTarget(
            { ...item, childId: 'nested', title: 'Nested review' },
            connection,
          ),
        )
      }
    >
      Open nested
    </button>
  );
}
function Parent() {
  return (
    <>
      <input aria-label="Parent draft" defaultValue="Keep this draft" />
      <SubagentTranscriptCard
        child={{ item, provider: 'claude', toolAnchor: true }}
      />
      <Nested />
    </>
  );
}
function tree(rootKey = 'parent') {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <PreviewProvider>
        <ConversationConnectionProvider value={connection}>
          <ChildChatNavigation rootKey={rootKey} title="Parent chat">
            <Parent />
          </ChildChatNavigation>
        </ConversationConnectionProvider>
      </PreviewProvider>
    </QueryClientProvider>
  );
}

test('the real child card opens the normal message renderer in the chat pane and breadcrumb restores its parent draft', async () => {
  render(tree());
  fireEvent.click(screen.getByRole('button', { name: /Review files/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));
  const trail = await screen.findByRole('navigation', {
    name: 'Chat breadcrumb',
  });
  expect(trail.textContent).toContain('Parent chat');
  expect(trail.textContent).toContain('Review files');
  const transcript = await screen.findByRole('log', {
    name: 'Conversation transcript',
  });
  expect(within(transcript).getByText('Inspect the child files')).toBeTruthy();
  expect(transcript.textContent).toContain('Review files');
  expect(
    await within(transcript).findByRole('heading', { name: 'Child answer' }),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  fireEvent.click(within(trail).getByRole('button', { name: 'Parent chat' }));
  expect(screen.getByRole('textbox', { name: 'Parent draft' })).toHaveProperty(
    'value',
    'Keep this draft',
  );
  expect(
    screen.queryByRole('navigation', { name: 'Chat breadcrumb' }),
  ).toBeNull();
});

test('Escape pops one level and changing the root cannot show the previous chat child', async () => {
  const view = render(tree());
  const opener = screen.getByRole('button', { name: 'Open nested' });
  opener.focus();
  fireEvent.click(opener);
  const trail = await screen.findByRole('navigation', {
    name: 'Chat breadcrumb',
  });
  fireEvent.keyDown(trail, { key: 'Escape' });
  await waitFor(() =>
    expect(
      screen.queryByRole('navigation', { name: 'Chat breadcrumb' }),
    ).toBeNull(),
  );
  await waitFor(() => expect(document.activeElement).toBe(opener));
  fireEvent.click(opener);
  view.rerender(tree('different-parent'));
  expect(
    screen.queryByRole('navigation', { name: 'Chat breadcrumb' }),
  ).toBeNull();
});

test('the mounted child transcript fits desktop and phone panes in both themes', async () => {
  const view = render(tree());
  fireEvent.click(screen.getByRole('button', { name: /Review files/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));
  await screen.findByRole('heading', { name: 'Child answer' });
  const graph = createUiModuleGraph();
  const stylesheets = [
    ...graph.closure(
      [
        'src-ui/src/components/chat/ChatMessageList.tsx',
        'src-ui/src/components/chat-dock/ChildChatNavigation.tsx',
        'src-ui/src/workspace-panes/agents/ChildWorkTranscript.tsx',
      ],
      { followDynamic: false },
    ),
  ].filter((path) => path.endsWith('.css'));
  const styles = ['src-ui/src/index.css', ...stylesheets]
    .map((path) => resolveCssImports(resolve(path)))
    .join('\n');
  assertNoImportsSurvive(styles);
  const output = resolve('test-results/ux-lane-C-render');
  mkdirSync(output, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const width of [1440, 412, 390]) {
      for (const theme of ['dark', 'light']) {
        const page = await browser.newPage({
          viewport: { width, height: 915 },
        });
        await page.setContent(
          `<!doctype html><html data-theme="${theme}"><head><style>${styles}</style></head><body style="margin:0"><main style="height:100dvh;display:flex;flex-direction:column">${view.container.innerHTML}</main></body></html>`,
        );
        await page.evaluate(async () => {
          await Promise.all(
            document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.effect?.getComputedTiming().iterations !== Infinity,
              )
              .map((animation) => animation.finished),
          );
        });
        const transcript = page.getByRole('log', {
          name: 'Conversation transcript',
        });
        await expect(transcript.isVisible()).resolves.toBe(true);
        const geometry = await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          controls: [
            ...document.querySelectorAll('.child-chat-trail button'),
          ].map((button) => button.getBoundingClientRect().height),
        }));
        expect(geometry.width).toBeLessThanOrEqual(width);
        expect(geometry.controls.every((height) => height >= 44)).toBe(true);
        await page.screenshot({
          path: `${output}/child-chat-${width}-${theme}.png`,
        });
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

test('a child keeps the parent header controls mounted in their portals', async () => {
  const leading = document.createElement('span');
  const trailing = document.createElement('span');
  document.body.append(leading, trailing);
  const coverage = vi.fn();
  const release = vi.fn();
  const absorb = vi.fn(() => release);
  try {
    render(
      <KeyboardShortcutsProvider>
        <QueryClientProvider client={new QueryClient()}>
          <PreviewProvider>
            <ConversationConnectionProvider value={connection}>
              <RegionChromeSlotsContext.Provider
                value={{
                  leading,
                  trailing,
                  regionMenu: { actions: [], absorb },
                }}
              >
                <ChildChatNavigation
                  rootKey="parent"
                  title="Parent chat"
                  onCoveredChange={coverage}
                >
                  <ChatDockHeader
                    chatIdentity={<span>Parent toolbar</span>}
                    regionVisible
                  />
                  <Parent />
                </ChildChatNavigation>
              </RegionChromeSlotsContext.Provider>
            </ConversationConnectionProvider>
          </PreviewProvider>
        </QueryClientProvider>
      </KeyboardShortcutsProvider>,
    );
    expect(within(leading).getByText('Parent toolbar')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open nested' }));
    const trail = await screen.findByRole('navigation', {
      name: 'Chat breadcrumb',
    });
    expect(within(leading).getByText('Parent toolbar')).toBeTruthy();
    expect(coverage).toHaveBeenLastCalledWith(true);
    expect(release).toHaveBeenCalledOnce();
    fireEvent.click(within(trail).getByRole('button', { name: 'Parent chat' }));
    expect(within(leading).getByText('Parent toolbar')).toBeTruthy();
    expect(coverage).toHaveBeenLastCalledWith(false);
  } finally {
    leading.remove();
    trailing.remove();
  }
});

test('an empty child record never mounts the initial-chat empty owner', async () => {
  history.entries = [];
  render(tree());
  fireEvent.click(screen.getByRole('button', { name: 'Open nested' }));
  expect(
    await screen.findByText('No messages in this transcript yet.'),
  ).toBeTruthy();
  expect(screen.queryByTestId('initial-chat-empty')).toBeNull();
});

test('a failed refresh keeps recorded messages visible with a recovery action', async () => {
  history.error = new Error('Transcript fixture unavailable');
  render(tree());
  fireEvent.click(screen.getByRole('button', { name: 'Open nested' }));
  expect(
    await screen.findByText('Could not refresh the transcript'),
  ).toBeTruthy();
  expect(screen.getByText('Inspect the child files')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(history.refetch).toHaveBeenCalledOnce();
});

test('a consumed external child intent stays open, then the pane controller returns to the exact parent draft', async () => {
  const controller = createRef<ChildChatController>();
  const consumed = vi.fn();
  const child = childChatTarget(item, connection);
  const paint = (initialChild: typeof child | undefined) => (
    <QueryClientProvider client={new QueryClient()}>
      <PreviewProvider>
        <ConversationConnectionProvider value={connection}>
          <ChildChatNavigation
            rootKey="parent"
            title="Parent chat"
            initialChild={initialChild}
            controllerRef={controller}
            onInitialChildConsumed={consumed}
          >
            <Parent />
          </ChildChatNavigation>
        </ConversationConnectionProvider>
      </PreviewProvider>
    </QueryClientProvider>
  );
  const view = render(paint(child));
  await screen.findByRole('heading', { name: 'Child answer' });
  expect(consumed).toHaveBeenCalledOnce();
  view.rerender(paint(undefined));
  expect(
    screen.getByRole('navigation', { name: 'Chat breadcrumb' }),
  ).toBeTruthy();
  act(() => controller.current?.reset());
  expect(
    screen.queryByRole('navigation', { name: 'Chat breadcrumb' }),
  ).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Parent draft' })).toHaveProperty(
    'value',
    'Keep this draft',
  );
});

test('a mounted child consumes live settlement instead of retaining its open-time running flag', async () => {
  const running = { ...item, childId: 'nested', status: 'running' as const };
  childWorkGlobalStore.reconcileSnapshot(connection.apiBase, [
    {
      threadId: 'parent',
      childWork: {
        children: {
          observability: 'reported',
          running: [running],
          observedAt: '2026-11-13T00:00:00Z',
        },
      },
    },
  ]);
  render(tree());
  fireEvent.click(screen.getByRole('button', { name: 'Open nested' }));
  await screen.findByRole('heading', { name: 'Child answer' });
  expect(
    vi.mocked(useChildWorkTranscriptQuery).mock.calls.at(-1)?.[0].running,
  ).toBe(true);
  act(() =>
    childWorkGlobalStore.reconcileSnapshot(connection.apiBase, [
      {
        threadId: 'parent',
        childWork: {
          children: {
            observability: 'reported',
            running: [],
            settled: [{ ...running, status: 'completed' }],
            observedAt: '2026-11-13T00:01:00Z',
          },
        },
      },
    ]),
  );
  await waitFor(() =>
    expect(
      vi.mocked(useChildWorkTranscriptQuery).mock.calls.at(-1)?.[0].running,
    ).toBe(false),
  );
});

test('an initially running delegate reader consumes its live terminal state', async () => {
  const delegate: ChildWorkItem = {
    ...item,
    producer: 'station-delegate',
    childId: 'delegate',
    status: 'running',
  };
  history.sessions = [
    { threadId: 'delegate', childWork: { asChild: delegate } },
  ];
  const target = {
    threadId: 'delegate',
    title: 'Delegate',
    running: true,
    connection,
  };
  const reader = () => (
    <QueryClientProvider client={new QueryClient()}>
      <ChildChatNavigation
        rootKey="parent"
        title="Parent"
        initialChild={target}
      >
        <input aria-label="Parent draft" />
      </ChildChatNavigation>
    </QueryClientProvider>
  );
  const view = render(reader());
  expect(
    (await screen.findByRole('status', { name: 'Delegate state' })).textContent,
  ).toBe('running');
  history.sessions = [
    {
      threadId: 'delegate',
      childWork: { asChild: { ...delegate, status: 'completed' } },
    },
  ];
  view.rerender(reader());
  await waitFor(() =>
    expect(
      screen.getByRole('status', { name: 'Delegate state' }).textContent,
    ).toBe('settled'),
  );
});
