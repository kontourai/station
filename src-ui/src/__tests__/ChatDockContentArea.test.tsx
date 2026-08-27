// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ChatDockContentArea } from '../components/chat-dock/ChatDockContentArea';

let historyPending: Promise<void> | null = null;
let historyError: Error | null = null;

vi.mock('../components/chat/ConversationHistory', () => ({
  ConversationHistory: () => {
    if (historyError) throw historyError;
    if (historyPending) throw historyPending;
    return <div role="dialog">Conversation history</div>;
  },
}));

vi.mock('../components/chat-dock/ChatDockBody', () => ({
  ChatDockBody: () => <div>Chat body</div>,
}));

describe('ChatDockContentArea history backdrop', () => {
  test('closes by pointer through a named non-tabbable semantic control', async () => {
    const onCloseHistory = vi.fn();
    render(
      <ChatDockContentArea
        activeSession={null}
        activeOrchestrationSession={null}
        activeOrchestrationSessionRead="present"
        onRetryOrchestrationSessions={() => {}}
        activeSessionId={null}
        sessions={[]}
        agents={[]}
        projects={[]}
        chatFontSize={14}
        dockHeight={400}
        showStatsPanel={false}
        showReasoning={false}
        showToolDetails={false}
        modelSupportsAttachments={false}
        fileAttachmentsSupported={false}
        modelProviders={[]}
        agentDefaultModelId={null}
        availableModels={[]}
        chatInput={{} as never}
        isHistoryOpen
        onCloseHistory={onCloseHistory}
        onToggleStatsPanel={vi.fn()}
        onTitleUpdate={vi.fn()}
        onDeleteSession={vi.fn()}
        onFocusSession={vi.fn()}
        onOpenConversation={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );

    const backdrop = screen.getByRole('button', {
      name: 'Close conversation history',
    });
    expect(backdrop.getAttribute('type')).toBe('button');
    expect(backdrop.getAttribute('tabindex')).toBe('-1');
    fireEvent.click(backdrop);
    expect(onCloseHistory).toHaveBeenCalledOnce();
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  test('keeps panel chrome and a skeleton visible while history is delayed', async () => {
    let resolveHistory: (() => void) | undefined;
    historyPending = new Promise<void>((resolve) => {
      resolveHistory = resolve;
    });
    renderHistoryPanel();

    expect(
      await screen.findByRole('status', {
        name: 'Loading conversation history',
      }),
    ).toBeTruthy();
    historyPending = null;
    resolveHistory?.();
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  test('contains a history failure in the panel and retries without losing the dock', async () => {
    const onCloseHistory = vi.fn();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    historyError = new Error('history chunk unavailable');
    renderHistoryPanel(onCloseHistory);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('No active session')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Close conversation history' }),
    );
    expect(onCloseHistory).toHaveBeenCalledOnce();

    historyError = null;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    consoleError.mockRestore();
  });
});

function renderHistoryPanel(onCloseHistory = vi.fn()) {
  return render(
    <ChatDockContentArea
      activeSession={null}
      activeOrchestrationSession={null}
      activeOrchestrationSessionRead="present"
      onRetryOrchestrationSessions={() => {}}
      activeSessionId={null}
      sessions={[]}
      agents={[]}
      projects={[]}
      chatFontSize={14}
      dockHeight={400}
      showStatsPanel={false}
      showReasoning={false}
      showToolDetails={false}
      modelSupportsAttachments={false}
      fileAttachmentsSupported={false}
      modelProviders={[]}
      agentDefaultModelId={null}
      availableModels={[]}
      chatInput={{} as never}
      isHistoryOpen
      onCloseHistory={onCloseHistory}
      onToggleStatsPanel={vi.fn()}
      onTitleUpdate={vi.fn()}
      onDeleteSession={vi.fn()}
      onFocusSession={vi.fn()}
      onOpenConversation={vi.fn()}
      onNewChat={vi.fn()}
    />,
  );
}
