/** @vitest-environment jsdom */
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import ImportedConversationPane from '../components/chat-dock/ImportedConversationPane';

const query = vi.hoisted(() => vi.fn());
const sendMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const updateChat = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useActiveChatSessionMessaging', () => ({
  useSendMessage: () => sendMessage,
}));
vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({ updateChat }),
}));
vi.mock('../contexts/active-chats-store', () => ({
  activeChatsStore: {
    getSnapshot: () => ({
      tab: { conversationId: 'conversation-1', agentSlug: 'claude' },
    }),
  },
}));
vi.mock('@kontourai/station-sdk', () => ({
  useOrchestrationSessionQuery: query,
}));
vi.mock('../components/session-detail/SessionDetail', () => ({
  SessionDetail: ({
    onAdopted,
  }: {
    onAdopted: (
      child: { threadId: string },
      intent: number,
      message: string,
    ) => void;
  }) => (
    <div>
      <p>Original conversation</p>
      <button
        type="button"
        onClick={() =>
          onAdopted({ threadId: 'continued' }, 0, 'My exact message')
        }
      >
        Confirm continuation
      </button>
    </div>
  ),
}));
function setup(onContinueInDock = vi.fn().mockResolvedValue(true)) {
  sendMessage.mockClear();
  updateChat.mockClear();
  query.mockImplementation((id: string) => ({
    data:
      id === 'source'
        ? { session: { threadId: 'source', controlMode: 'read-only-attached' } }
        : id === 'continued'
          ? {
              session: {
                threadId: 'continued',
                conversationId: 'conversation-1',
                controlMode: 'station-owned',
              },
            }
          : undefined,
    refetch: vi.fn(),
  }));
  const view = render(
    <ImportedConversationPane
      threadId="source"
      apiBase=""
      onContinueInDock={onContinueInDock}
    />,
  );
  return { ...view, onContinueInDock };
}
describe('imported conversation in the dock', () => {
  test('renders inline without opening a dialog or continuing automatically', () => {
    const { onContinueInDock } = setup();
    expect(screen.getByRole('region', { name: 'Conversation' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Original conversation')).toBeTruthy();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(onContinueInDock).not.toHaveBeenCalled();
  });
  test('opens the confirmed durable conversation through the normal dock controller', async () => {
    const view = setup();
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm continuation' }),
    );
    await waitFor(() =>
      expect(view.onContinueInDock).toHaveBeenCalledWith(
        'conversation-1',
        expect.any(Function),
      ),
    );
    expect(updateChat).toHaveBeenCalledWith('tab', {
      input: 'My exact message',
    });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      'tab',
      'claude',
      'conversation-1',
      'My exact message',
    );
    const isCurrent = view.onContinueInDock.mock.calls[0][1];
    expect(isCurrent()).toBe(true);
    view.unmount();
    expect(isCurrent()).toBe(false);
  });
  test('failed opening retains the original and retries opening, not adoption', async () => {
    const onContinue = vi.fn().mockResolvedValue(false);
    setup(onContinue);
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm continuation' }),
    );
    const retry = await screen.findByRole('button', { name: 'Retry opening' });
    expect(screen.getByText('Original conversation')).toBeTruthy();
    expect(sendMessage).not.toHaveBeenCalled();
    onContinue.mockResolvedValue(true);
    fireEvent.click(retry);
    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
  });
  test('uses the dock-sized box, not a fixed viewport overlay', async () => {
    setup();
    const markup = screen.getByRole('region', {
      name: 'Conversation',
    }).outerHTML;
    const css = resolveCssImports(
      resolve(
        import.meta.dirname,
        '../components/chat-dock/ImportedConversationPane.css',
      ),
    );
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 1200, height: 800 },
      });
      await page.setContent(
        `<style>${css}</style><main style="display:flex;width:600px;height:400px;margin:60px">${markup}</main>`,
      );
      const box = await page
        .getByRole('region', { name: 'Conversation' })
        .boundingBox();
      const host = await page.locator('main').boundingBox();
      expect(box).toEqual(host);
    } finally {
      await browser.close();
    }
  });
});

test('a failed refresh preserves history and explains that updates are unavailable', () => {
  const view = setup();
  query.mockImplementation((id: string) => ({
    data:
      id === 'source'
        ? { session: { threadId: 'source', controlMode: 'read-only-attached' } }
        : undefined,
    isError: id === 'source',
    refetch: vi.fn(),
  }));
  view.rerender(
    <ImportedConversationPane
      threadId="source"
      apiBase=""
      onContinueInDock={view.onContinueInDock}
    />,
  );
  expect(screen.getByRole('alert').textContent).toContain(
    'Could not refresh this conversation',
  );
  expect(screen.getByText('Original conversation')).toBeTruthy();
  expect(screen.queryByText('Could not load this conversation')).toBeNull();
});
