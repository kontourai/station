import { PreviewProvider } from '../contexts/PreviewContext';
import { deviceSettingsStore } from '../lib/device-settings-store';
// @vitest-environment jsdom

import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../components/icons/UserIcon', () => ({ UserIcon: () => null }));

const adoptOrchestrationSession = vi.hoisted(() => vi.fn());
/** #3429: the first continuation launches through Starter Work. */
const starter = vi.hoisted(() => ({
  unbound: false,
  launch: vi.fn(),
}));
/**
 * `importOriginal`, not a bare factory. A factory mock makes every unlisted
 * export a hard throw, so this file went red the moment the component reached
 * for one more of them (`getStarterWork`, `launchContinueSessionStarter`,
 * `AdoptSessionError`) — and `AdoptSessionError` in particular has to be the
 * REAL class here, because the component's classifier branches on
 * `error instanceof AdoptSessionError` to decide whether a failure keeps its
 * declared class or gets re-derived from the transport.
 *
 * Only what this file actually drives is overridden.
 */
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  adoptOrchestrationSession,
  createAdoptOrchestrationSessionIntent: () => ({
    idempotencyKey: '55555555-5555-4555-8555-555555555555',
  }),
  // An already-bound starter is the branch that continues through
  // `adoptOrchestrationSession`, which is the call every test below drives.
  // Answered here rather than stood up: no server exists in this file, and a
  // real read would only decide which continuation path runs.
  launchContinueSessionStarter: starter.launch,
  getStarterWork: async () =>
    starter.unbound
      ? { state: 'unbound' as const }
      : {
          state: 'bound' as const,
          binding: {
            schemaVersion: 1 as const,
            starterId: 'continue-session',
            targetRef: {
              kind: 'session' as const,
              id: 'external:claude:raw-thread-id',
            },
            operationId: 'starter-session:test',
            boundAt: '2026-06-27T00:00:00.000Z',
          },
        },
}));

import { AdoptSessionError } from '@kontourai/station-sdk';
import * as conversationClient from '@kontourai/station-sdk/client';
import { ConversationHeaderActionSlot } from '../components/conversation/ConversationHeaderActionSlot';
import { AttachedSessionDetail } from '../components/session-detail/AttachedSessionDetail';
import { ToastProvider, toastStore } from '../contexts/ToastContext';
import {
  handOffAttachedContinuation,
  takeAttachedContinuationHandoff,
} from '../lib/attached-continuation-handoff';

const base = {
  provider: 'claude',
  threadId: 't1',
  createdAt: '2026-06-27T00:00:00.000Z',
};
let n = 0;
const ev = (
  e: Partial<CanonicalRuntimeEvent> & { method: string },
): CanonicalRuntimeEvent =>
  ({ eventId: `e${n++}`, ...base, ...e }) as unknown as CanonicalRuntimeEvent;

async function renderAttached({
  presentation = 'inspector',
  onAdopted = vi.fn(),
  connected = true,
  upgradeRequired,
  streamError,
  liveStreamStoppedTerminal,
  connectionInterrupted,
  historyLoaded,
  historyStoppedTerminal,
  capabilityRecoveryExhausted,
  onRetryCapabilityRecovery,
  onContinueInChat,
  session: sessionOverrides,
  events,
}: {
  presentation?: 'inspector' | 'chat';
  onAdopted?: (...args: any[]) => void;
  connected?: boolean;
  upgradeRequired?: boolean;
  streamError?: Error;
  liveStreamStoppedTerminal?: boolean;
  connectionInterrupted?: boolean;
  historyLoaded?: boolean;
  historyStoppedTerminal?: boolean;
  capabilityRecoveryExhausted?: boolean;
  onRetryCapabilityRecovery?: () => void;
  onContinueInChat?: (draft: string) => void;
  session?: Record<string, unknown>;
  events?: CanonicalRuntimeEvent[];
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // The real provider, not a stub: the component calls `useToast` at its top
  // (AttachedSessionDetail.tsx), which throws outside a provider — so a render
  // without one fails before any assertion in this file runs.
  const view = render(
    <QueryClientProvider client={queryClient}>
      <PreviewProvider>
        <ToastProvider>
          <AttachedSessionDetail
            apiBase="http://station.test"
            // 'inspector' is Activity's host, which shows the header.
            showHeader={presentation === 'inspector'}
            session={
              {
                threadId: 'external:claude:raw-thread-id',
                provider: 'claude',
                controlMode: 'read-only-attached',
                attachedSource: {
                  kind: 'claude-transcript',
                  externalSessionId: 'fixture-native-source',
                  affinity: {
                    kind: 'fixture-home',
                    ref: 'verified-fixture-home',
                  },
                },
                createdAt: '2026-06-27T00:00:00.000Z',
                updatedAt: '2026-06-27T00:00:00.000Z',
                // A conversation a project claims, unless a test says otherwise
                // (#3386: one no project claims continues as a No project chat).
                projectSlug: 'station',
                ...sessionOverrides,
              } as any
            }
            onAdopted={onAdopted}
            getSelectionIntent={() => 0}
            events={
              events ?? [
                ev({
                  method: 'turn.started',
                  turnId: 'r1',
                  prompt: 'list files',
                }),
                ev({
                  method: 'content.text-delta',
                  itemId: 'i1',
                  delta: 'Sure.',
                }),
                ev({
                  method: 'turn.completed',
                  turnId: 'r1',
                  finishReason: 'stop',
                }),
              ]
            }
            connected={connected}
            upgradeRequired={upgradeRequired}
            streamError={streamError}
            liveStreamStoppedTerminal={liveStreamStoppedTerminal}
            connectionInterrupted={connectionInterrupted}
            historyLoaded={historyLoaded}
            historyStoppedTerminal={historyStoppedTerminal}
            capabilityRecoveryExhausted={capabilityRecoveryExhausted}
            onRetryCapabilityRecovery={onRetryCapabilityRecovery}
            onContinueInChat={onContinueInChat}
            visualViewport={{ style: {} } as any}
          />
        </ToastProvider>
      </PreviewProvider>
    </QueryClientProvider>,
  );
  await within(view.container).findByRole('textbox');
  await within(view.container).findByTestId('session-transcript');
  return view;
}

/** Type a message and press Send: that continues at once, with the draft. */
function sendFromComposer(message = 'carry on') {
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
    target: { value: message },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

/** The one Continue action, pinned above the conversation; needs no message. */
function continueButton() {
  return screen.getByRole('button', {
    name: 'Continue in Station',
  }) as HTMLButtonElement;
}

test('a read-only attached composer continues in Station and cannot issue a direct reply', async () => {
  const directReply = vi.spyOn(conversationClient, 'continueExecutionMessage');
  const directSend = vi.spyOn(
    conversationClient,
    'sendExecutionMessageWithInventory',
  );
  try {
    await renderAttached();
    // Send is the ordinary Send: it continues in Station, never replies to
    // the source directly.
    expect(screen.getByRole('button', { name: /^Send$/ })).toBeTruthy();
    expect(screen.getByPlaceholderText('Message…')).toBeTruthy();
    adoptOrchestrationSession.mockResolvedValueOnce({ threadId: 'continued' });
    sendFromComposer('A new owned continuation');
    await waitFor(() => expect(adoptOrchestrationSession).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(directReply).not.toHaveBeenCalled();
    expect(directSend).not.toHaveBeenCalled();
  } finally {
    directReply.mockRestore();
    directSend.mockRestore();
  }
});

test('typing a draft changes nothing; Continue is one visible action that needs no message', async () => {
  adoptOrchestrationSession.mockClear();
  await renderAttached({ presentation: 'chat' });
  const composer = screen.getByRole('textbox', {
    name: 'Message',
  }) as HTMLTextAreaElement;
  expect(composer.disabled).toBe(false);
  expect(composer.readOnly).toBe(false);
  expect(screen.getByText('Sure.')).toBeTruthy();
  // One copy icon per message: the user's prompt and the answer.
  expect(
    screen.getByRole('button', { name: 'Copy your message' }),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Copy answer' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Continue here' })).toBeNull();
  fireEvent.focus(composer);
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.change(composer, { target: { value: 'Keep my draft' } });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(composer.value).toBe('Keep my draft');
  expect(screen.getByText('Sure.')).toBeTruthy();
  expect(adoptOrchestrationSession).not.toHaveBeenCalled();
});

test('Continue in Station adopts at once with no message and opens no confirmation', async () => {
  adoptOrchestrationSession.mockClear();
  const child = { threadId: 'continued' };
  adoptOrchestrationSession.mockResolvedValue(child);
  const onAdopted = vi.fn();
  await renderAttached({ presentation: 'chat', onAdopted });
  const action = continueButton();
  expect(action.disabled).toBe(false);
  fireEvent.click(action);
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() =>
    expect(onAdopted).toHaveBeenCalledWith(child, expect.any(Number), ''),
  );
  expect(adoptOrchestrationSession).toHaveBeenCalledTimes(1);
});

test('Continue in Station carries a typed draft to the continuation', async () => {
  adoptOrchestrationSession.mockClear();
  const child = { threadId: 'continued' };
  adoptOrchestrationSession.mockResolvedValue(child);
  const onAdopted = vi.fn();
  await renderAttached({ presentation: 'chat', onAdopted });
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
    target: { value: 'Typed first' },
  });
  fireEvent.click(continueButton());
  await waitFor(() =>
    expect(onAdopted).toHaveBeenCalledWith(
      child,
      expect.any(Number),
      'Typed first',
    ),
  );
});

// On a plain http:// origin `navigator.clipboard` does not exist. The copy
// must still report that it failed rather than throw from the click handler.
test('copying a message where no clipboard exists says it was not copied', async () => {
  toastStore.clear();
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: undefined,
  });
  try {
    await renderAttached({ presentation: 'chat' });
    fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }));
    await waitFor(() =>
      expect(toastStore.getSnapshot().map((toast) => toast.message)).toContain(
        "Couldn't copy to the clipboard",
      ),
    );
  } finally {
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
    else delete (navigator as { clipboard?: unknown }).clipboard;
    toastStore.clear();
  }
});

test('Enter continues with the exact draft; Shift+Enter and IME do not', async () => {
  adoptOrchestrationSession.mockClear();
  const child = { threadId: 'continued' };
  adoptOrchestrationSession.mockResolvedValue(child);
  const onAdopted = vi.fn();
  await renderAttached({ presentation: 'chat', onAdopted });
  const composer = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.keyDown(composer, { key: 'Enter' });
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.change(composer, { target: { value: 'My exact\nmessage' } });
  fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true });
  fireEvent.keyDown(composer, { key: 'Enter', isComposing: true });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(adoptOrchestrationSession).not.toHaveBeenCalled();
  fireEvent.keyDown(composer, { key: 'Enter' });
  await waitFor(() =>
    expect(onAdopted).toHaveBeenCalledWith(
      child,
      expect.any(Number),
      'My exact\nmessage',
    ),
  );
  expect(adoptOrchestrationSession).toHaveBeenCalledTimes(1);
});

describe('a message typed in Activity is continued by the chat dock (#3552, #3454)', () => {
  test('Activity hands the exact draft over and continues nothing itself', async () => {
    adoptOrchestrationSession.mockClear();
    const onContinueInChat = vi.fn();
    await renderAttached({ onContinueInChat });
    sendFromComposer('My exact\nmessage');
    expect(onContinueInChat).toHaveBeenCalledWith('My exact\nmessage');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(adoptOrchestrationSession).not.toHaveBeenCalled();
  });

  test('the dock reader continues the handed-over draft at once', async () => {
    adoptOrchestrationSession.mockClear();
    adoptOrchestrationSession.mockResolvedValue({ threadId: 'continued' });
    const onAdopted = vi.fn();
    handOffAttachedContinuation({
      threadId: 'external:claude:raw-thread-id',
      draft: 'From Activity',
    });
    await renderAttached({ presentation: 'chat', onAdopted });
    expect(
      (screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement)
        .value,
    ).toBe('From Activity');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() =>
      expect(onAdopted).toHaveBeenCalledWith(
        { threadId: 'continued' },
        expect.any(Number),
        'From Activity',
      ),
    );
  });

  test('a dock reader already open on the conversation receives the hand-off', async () => {
    adoptOrchestrationSession.mockClear();
    adoptOrchestrationSession.mockResolvedValue({ threadId: 'continued' });
    await renderAttached({ presentation: 'chat' });
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() =>
      handOffAttachedContinuation({
        threadId: 'external:claude:raw-thread-id',
        draft: 'While open',
      }),
    );
    expect(
      (screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement)
        .value,
    ).toBe('While open');
    await waitFor(() =>
      expect(adoptOrchestrationSession).toHaveBeenCalledTimes(1),
    );
  });

  test('with Activity and the dock open together, Continue lands in the dock reader, never Activity’s', async () => {
    adoptOrchestrationSession.mockClear();
    adoptOrchestrationSession.mockResolvedValue({ threadId: 'continued' });
    const dockAdopted = vi.fn();
    const activity = await renderAttached({
      onContinueInChat: (draft) =>
        handOffAttachedContinuation({
          threadId: 'external:claude:raw-thread-id',
          draft,
        }),
    });
    const dock = await renderAttached({
      presentation: 'chat',
      onAdopted: dockAdopted,
    });
    const activityView = within(activity.container);
    const dockView = within(dock.container);
    fireEvent.change(activityView.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'Typed in Activity' },
    });
    fireEvent.click(
      activityView.getByRole('button', { name: 'Continue in Station' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      (
        dockView.getByRole('textbox', {
          name: 'Message',
        }) as HTMLTextAreaElement
      ).value,
    ).toBe('Typed in Activity');
    expect(
      (
        activityView.getByRole('textbox', {
          name: 'Message',
        }) as HTMLTextAreaElement
      ).value,
    ).toBe('');
    // Only the dock's reader continues, once, with Activity's exact draft.
    await waitFor(() =>
      expect(dockAdopted).toHaveBeenCalledWith(
        { threadId: 'continued' },
        expect.any(Number),
        'Typed in Activity',
      ),
    );
    expect(adoptOrchestrationSession).toHaveBeenCalledTimes(1);
    expect(
      takeAttachedContinuationHandoff('external:claude:raw-thread-id'),
    ).toBe(null);
  });

  test('a dock reader that cannot continue keeps the draft and continues nothing', async () => {
    adoptOrchestrationSession.mockClear();
    handOffAttachedContinuation({
      threadId: 'external:claude:raw-thread-id',
      draft: 'Waiting',
    });
    await renderAttached({
      presentation: 'chat',
      session: { provider: 'bedrock' },
    });
    expect(
      (screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement)
        .value,
    ).toBe('Waiting');
    expect(continueButton().disabled).toBe(true);
    expect(adoptOrchestrationSession).not.toHaveBeenCalled();
  });

  test('a hand-off for another conversation is left for its own reader', async () => {
    handOffAttachedContinuation({
      threadId: 'someone-else',
      draft: 'Not mine',
    });
    await renderAttached({ presentation: 'chat' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(takeAttachedContinuationHandoff('someone-else')).toBe('Not mine');
  });
});

describe('AttachedSessionDetail permission-posture row badge (station#1424)', () => {
  test('keeps continuation disabled until source affinity is observed', async () => {
    adoptOrchestrationSession.mockClear();
    await renderAttached({
      session: {
        attachedSource: {
          kind: 'claude-transcript',
          externalSessionId: 'unverified-source',
        },
      },
    });
    const composer = screen.getByRole('textbox', {
      name: 'Message',
    }) as HTMLTextAreaElement;
    expect(composer.disabled).toBe(true);
    expect(
      screen.getByText('Waiting for the source configuration to be verified.'),
    ).toBeTruthy();
    const send = screen.getByRole('button', { name: 'Continue in Station' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(send);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(adoptOrchestrationSession).not.toHaveBeenCalled();
  });

  test.each(['bedrock', 'future-engine'])(
    'keeps unsupported or unknown %s continuation visible and disabled',
    async (provider) => {
      adoptOrchestrationSession.mockClear();
      await renderAttached({ session: { provider } });
      const composer = screen.getByRole('textbox', {
        name: 'Message',
      }) as HTMLTextAreaElement;
      expect(composer.disabled).toBe(true);
      expect(
        screen.getByText(
          'Station has not established independent continuation support for this engine.',
        ),
      ).toBeTruthy();
      fireEvent.click(
        screen.getByRole('button', { name: 'Continue in Station' }),
      );
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(adoptOrchestrationSession).not.toHaveBeenCalled();
    },
  );

  test.each([false, true])(
    'Codex continuation requires an observed completed boundary: %s',
    async (completed) => {
      await renderAttached({
        session: {
          provider: 'codex',
          attachedSource: {
            kind: 'codex-rollout',
            externalSessionId: 'fixture-native-source',
            affinity: {
              kind: 'codex-config-home',
              ref: 'verified-fixture-home',
            },
            ...(completed
              ? {
                  completedBoundary: {
                    kind: 'completed-turn',
                    providerTurnId: 't1',
                    observedEventId: 'e1',
                  },
                }
              : {}),
          },
        },
      });
      const composer = screen.getByRole('textbox', {
        name: 'Message',
      }) as HTMLTextAreaElement;
      expect(composer.disabled).toBe(!completed);
      if (!completed)
        expect(
          screen.getByText(
            'No completed source turn is available for continuation.',
          ),
        ).toBeTruthy();
    },
  );

  test('the read-only posture is stated once in the header, not badged onto every row', async () => {
    await renderAttached();
    const header = document.querySelector('.sessions-detail__chat-header');
    expect(header?.textContent).toContain('Started in Claude Code · Read only');
    // The messages read as the ordinary chat: no per-row role cards or
    // posture badges.
    expect(screen.getByText('Sure.')).toBeTruthy();
    expect(screen.getAllByText(/Read only/)).toHaveLength(1);
    // One copy icon per message: the user's prompt and the answer.
    expect(
      screen.getByRole('button', { name: 'Copy your message' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy answer' })).toBeTruthy();
  });

  test('a stream that has not opened yet is connecting, not unresponsive', async () => {
    await renderAttached({ connected: false, events: [] });
    expect(screen.getByLabelText('Reading the conversation')).toBeTruthy();
    expect(
      document.querySelector('.sessions-detail__connection-state'),
    ).toBeNull();
    expect(screen.queryByText(/isn't responding/)).toBeNull();
  });

  test('a history read that failed and is retrying is a blip, not an outage, until the hook says otherwise', async () => {
    await renderAttached({
      connected: true,
      streamError: new Error('Failed to fetch'),
    });
    expect(
      document.querySelector('.sessions-detail__connection-state'),
    ).toBeNull();
    expect(screen.queryByText(/isn't responding/)).toBeNull();
  });

  test('an empty transcript claims nothing about the conversation while its history is unavailable', async () => {
    const first = await renderAttached({
      connected: true,
      events: [],
      upgradeRequired: true,
    });
    expect(screen.queryByText(/messages yet|Waiting for/)).toBeNull();
    first.unmount();
    const second = await renderAttached({ connected: true, events: [] });
    expect(screen.getByLabelText('Reading the conversation')).toBeTruthy();
    expect(screen.queryByText('No messages yet.')).toBeNull();
    // Only a completed history read can say the conversation is empty.
    second.unmount();
    await renderAttached({ connected: true, events: [], historyLoaded: true });
    expect(screen.getByText('No messages in this session yet.')).toBeTruthy();
  });

  test('a live stream interrupted past its grace window says so', async () => {
    await renderAttached({ connected: false, connectionInterrupted: true });
    expect(
      screen.getByText("Station isn't responding. Retrying automatically."),
    ).toBeTruthy();
  });

  test('uses an engine session fallback and keeps the raw id in Details', async () => {
    await renderAttached();

    expect(
      screen.getByRole('heading', { name: 'Claude Code session' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('heading', { name: /raw thread id/i }),
    ).toBeNull();
    expect(screen.getByText('external:claude:raw-thread-id')).toBeTruthy();
  });

  /**
   * archive#3227. This heading was an INLINE copy of `sessionTitle`'s
   * first and last branches — `displayTitle?.trim || `${displayProvider}
   * session`` — with the middle one missing. The case above could never
   * notice, because a session with no delegation takes the same branch in
   * both versions. An attached session that DOES carry a delegated task id
   * was the whole divergence: this pane said "Claude Code session" while the
   * list it was opened from said "Worker task · adopt review", for one
   * session, one click apart.
   */
  test('a delegated attached session is named by its task, as the list names it', async () => {
    await renderAttached({
      session: { delegation: { taskId: 'task:adopt-review' } },
    });

    expect(
      screen.getByRole('heading', { name: 'Worker task · adopt review' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('heading', { name: 'Claude Code session' }),
    ).toBeNull();
  });

  test("the server's own title still outranks both branches", async () => {
    await renderAttached({
      session: { displayTitle: 'Ship the Home history fix' },
    });

    expect(
      screen.getByRole('heading', { name: 'Ship the Home history fix' }),
    ).toBeTruthy();
  });

  test('collapses a disconnected stream into one plain-language state and keeps continuation available', async () => {
    await renderAttached({
      connected: false,
      connectionInterrupted: true,
      streamError: new Error('Session history transport failed.'),
    });

    expect(
      screen.getByText("Station isn't responding. Retrying automatically."),
    ).toBeTruthy();
    // The stream's SSE state says nothing about the REST adoption channel
    // (archive#2630) — the recovery action stays enabled.
    expect(
      (screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement)
        .disabled,
    ).toBe(false);
    expect(screen.queryByText('○ reconnecting')).toBeNull();
    expect(screen.getByText('Session history transport failed.')).toBeTruthy();
  });

  /**
   * archive#3426. The generic "retrying automatically" copy was false for a
   * credential rejection (nothing is retrying) and for an exhausted
   * capability re-probe (nothing is retrying, but it isn't a rejection
   * either). These pin the three honest states the fold now derives.
   */
  test('names the cause when the live stream stopped for good on a credential rejection', async () => {
    await renderAttached({
      connected: false,
      streamError: new Error('Session history transport failed.'),
      liveStreamStoppedTerminal: true,
    });

    expect(
      screen.getByText(
        "Station rejected this session's credentials and stopped reconnecting.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("Station isn't responding. Retrying automatically."),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry now' })).toBeNull();
  });

  test('names the cause when the history-window ladder stopped for good on a credential rejection', async () => {
    await renderAttached({
      connected: true,
      streamError: new Error('Unauthorized'),
      historyStoppedTerminal: true,
    });

    expect(
      screen.getByText(
        "Station rejected this session's credentials and stopped reconnecting.",
      ),
    ).toBeTruthy();
  });

  test('offers a manual retry when the capability re-probe is exhausted — not a credential story', async () => {
    const onRetryCapabilityRecovery = vi.fn();
    await renderAttached({
      connected: false,
      streamError: new Error('Session history transport failed.'),
      capabilityRecoveryExhausted: true,
      onRetryCapabilityRecovery,
    });

    expect(
      screen.getByText(
        "Station stopped checking for this session's history and live updates automatically.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("Station isn't responding. Retrying automatically."),
    ).toBeNull();
    expect(
      screen.queryByText(/rejected this session's credentials/),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(onRetryCapabilityRecovery).toHaveBeenCalledTimes(1);
  });

  test('a terminal credential rejection takes precedence over an also-exhausted capability budget', async () => {
    await renderAttached({
      connected: false,
      streamError: new Error('Session history transport failed.'),
      liveStreamStoppedTerminal: true,
      capabilityRecoveryExhausted: true,
    });

    expect(
      screen.getByText(
        "Station rejected this session's credentials and stopped reconnecting.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry now' })).toBeNull();
  });

  test('an upgrade-required stream names the update, never the retrying story', async () => {
    await renderAttached({
      connected: false,
      upgradeRequired: true,
      streamError: new Error('capability negotiation failed'),
    });

    expect(
      screen.getByText(
        "This Station needs an update before it can show this session's history.",
      ),
    ).toBeTruthy();
    // Retrying cannot cure an incompatible host (sol).
    expect(
      screen.queryByText("Station isn't responding. Retrying automatically."),
    ).toBeNull();
  });

  test('a non-transport continuation failure is not narrated as unreachability', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    adoptOrchestrationSession.mockRejectedValueOnce(
      new Error('source session is already being continued'),
    );
    await renderAttached();

    fireEvent.click(continueButton());
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        "Couldn't start the continuation. Technical detail is under Details.",
      ),
    );
    expect(screen.queryByText(/isn't responding/)).toBeNull();
    // The raw cause is also kept under Details.
    expect(
      screen.getByText('source session is already being continued'),
    ).toBeTruthy();
  });

  test('a certainly unsent continuation keeps the sibling recovery copy and retry enabled', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // The SDK's own not-sent failure: its message matches no transport
    // pattern and its class is not uncertain, so only the certain-not-sent
    // branch can produce the "isn't responding" copy below.
    adoptOrchestrationSession.mockRejectedValueOnce(
      new AdoptSessionError({
        failureClass: 'certain-not-sent',
        message: 'The continuation request could not reach Station.',
        retryable: true,
      }),
    );
    await renderAttached();

    fireEvent.click(continueButton());
    await waitFor(() =>
      expect(
        screen.getByText(
          "Couldn't start the continuation. Station isn't responding.",
        ),
      ).toBeTruthy(),
    );
    expect(
      screen.getByText('The continuation request could not reach Station.'),
    ).toBeTruthy();
    // Nothing was sent, so there is no outcome to be unsure about.
    expect(screen.queryByText(/continue it twice/)).toBeNull();
    expect(continueButton().getAttribute('disabled')).toBeNull();
    vi.restoreAllMocks();
  });

  test('an uncertain continuation preserves the recovery copy and offers safe retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    adoptOrchestrationSession.mockRejectedValueOnce(
      new AdoptSessionError({
        failureClass: 'uncertain-no-response',
        message: 'Station did not answer before the request ended.',
        retryable: true,
      }),
    );
    await renderAttached();

    fireEvent.click(continueButton());
    await screen.findByText(
      "Couldn't start the continuation. Station isn't responding.",
    );
    expect(screen.getByText("Retrying won't continue it twice.")).toBeTruthy();
    expect(continueButton().getAttribute('disabled')).toBeNull();
    vi.restoreAllMocks();
  });

  test('a bound-starter rejection is classified, not passed through raw (#2722)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // A plain transport error, as `resolveApiBase` throws before the SDK's
    // own classifier runs. Only the component's `catch` can turn it into an
    // uncertain outcome, so the safe-retry line proves the rejection was
    // awaited inside the `try` rather than returned past it.
    adoptOrchestrationSession.mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    );
    await renderAttached();

    fireEvent.click(continueButton());
    await screen.findByText(
      "Couldn't start the continuation. Station isn't responding.",
    );
    expect(screen.getByText("Retrying won't continue it twice.")).toBeTruthy();
    vi.restoreAllMocks();
  });
});

// The attached transcript used to map projected parts with its own subset of
// fields, so a coded runtime error lost its code and rendered the engine's raw
// sentence where the dock and the Station-owned detail translate it.
test.each(['inspector', 'chat'] as const)(
  '%s: a coded runtime error renders the translated copy, as in chat',
  async (presentation) => {
    await renderAttached({
      presentation,
      events: [
        ev({ method: 'turn.started', turnId: 'r2', prompt: 'Retry the build' }),
        ev({
          method: 'runtime.error',
          turnId: 'r2',
          severity: 'error',
          code: 'engine-session-binding-dead',
          message: 'No conversation found with session ID: 1234',
        } as never),
      ],
    });
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/could not reopen|session was lost/i);
    expect(text).not.toContain('⚠️ No conversation found with session ID: 1234');
  },
);

// Same mapping, but this view cannot answer anything: a request bound to a
// tool call must not offer Approve/Deny here.
test.each(['inspector', 'chat'] as const)(
  '%s: a pending tool request offers no answer controls in the read-only transcript',
  async (presentation) => {
    await renderAttached({
      presentation,
      events: [
        ev({ method: 'turn.started', turnId: 'r3', prompt: 'clean up' }),
        ev({
          method: 'tool.started',
          turnId: 'r3',
          toolCallId: 'c1',
          toolName: 'Bash',
          args: { command: 'rm -rf build' },
        } as never),
        ev({
          method: 'request.opened',
          turnId: 'r3',
          requestId: 'rq1',
          requestType: 'approval',
          title: 'Allow Bash',
          payload: { toolCallId: 'c1', toolName: 'Bash' },
        } as never),
      ],
    });
    expect(screen.getAllByText(/Bash/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /allow once/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^deny/i })).toBeNull();
  },
);

describe('AttachedSessionDetail transcript markers (station#3415)', () => {
  const turnWith = (namespace: string, type: string) => [
    ev({ method: 'turn.started', turnId: 'r1', prompt: 'list files' }),
    ev({ method: 'content.text-delta', turnId: 'r1', delta: 'First half.' }),
    ev({
      method: 'extension.notification',
      turnId: 'r1',
      namespace,
      type,
      payload: { source: 'provider-event' },
    } as Partial<CanonicalRuntimeEvent> & { method: string }),
    ev({ method: 'content.text-delta', turnId: 'r1', delta: 'Second half.' }),
    ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'stop' }),
  ];

  for (const presentation of ['chat', 'inspector'] as const) {
    test(`a mid-turn Codex compaction renders one marker line after its whole turn (${presentation})`, async () => {
      await renderAttached({
        presentation,
        events: turnWith('codex-rollout', 'context-compacted'),
      });
      const markers = screen.getAllByText('Context compacted during this turn');
      expect(markers).toHaveLength(1);
      const marker = markers[0]!.closest('.transcript-marker')!;
      expect(marker).toBeTruthy();
      // The turn stays one row; the marker follows all of it.
      const answer = screen.getByText(/First half\.\s*Second half\./);
      expect(
        answer.compareDocumentPosition(marker) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      // A marker is not a speaker row: no "You" label stands over it.
      expect(
        marker.closest('[data-testid="session-transcript-message"]'),
      ).toBeNull();
    });
  }

  test('an unbound tuple renders nothing and leaves the turn in one row', async () => {
    await renderAttached({
      presentation: 'chat',
      events: turnWith('codex-rollout', 'never-seen'),
    });
    expect(document.querySelector('.transcript-marker')).toBeNull();
    expect(screen.getByText(/First half\.\s*Second half\./)).toBeTruthy();
  });
});

describe('a conversation no project claims (#3386)', () => {
  test('a project conversation names no choice and keeps its plain Continue', async () => {
    adoptOrchestrationSession.mockClear();
    adoptOrchestrationSession.mockResolvedValue({ threadId: 'continued' });
    await renderAttached({ presentation: 'chat' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'carry on' },
    });
    expect(screen.queryByTestId('attached-continuation-no-project')).toBeNull();
    fireEvent.click(continueButton());
    await waitFor(() =>
      expect(adoptOrchestrationSession).toHaveBeenCalledTimes(1),
    );
    expect(adoptOrchestrationSession.mock.calls[0]![0]).not.toHaveProperty(
      'target',
    );
  });

  test('the inspector explains the No project chat in the conversation folder before Continue', async () => {
    adoptOrchestrationSession.mockClear();
    await renderAttached({
      session: { projectSlug: undefined, cwd: '/work/scratch/app' },
    });
    // The choice is stated beside the one Continue action, before anything
    // is requested; there is no confirmation to read it in.
    // The inspector's header carries the action; the choice sits right
    // under it, in the one notice line.
    const note = screen.getByTestId('attached-continuation-no-project');
    expect(
      within(screen.getByTestId('attached-continue-notice')).getByTestId(
        'attached-continuation-no-project',
      ),
    ).toBe(note);
    expect(
      within(
        document.querySelector('.sessions-detail__chat-header') as HTMLElement,
      ).getByRole('button', { name: 'Continue in Station' }),
    ).toBeTruthy();
    expect(note.textContent).toContain(
      'No project: the agent works only in /work/scratch/app.',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(adoptOrchestrationSession).not.toHaveBeenCalled();
  });

  test('the No project note offers a Project for that folder as an action', async () => {
    adoptOrchestrationSession.mockClear();
    window.history.replaceState(null, '', '/');
    await renderAttached({
      presentation: 'chat',
      session: { projectSlug: undefined, cwd: '/work/scratch/app' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'keep me' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Add a project instead' }),
    );
    expect(window.location.pathname).toBe('/projects/new');
    expect(new URLSearchParams(window.location.search).get('directory')).toBe(
      '/work/scratch/app',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(adoptOrchestrationSession).not.toHaveBeenCalled();
    // The message is still there to continue later.
    expect(
      (screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement)
        .value,
    ).toBe('keep me');
    window.history.replaceState(null, '', '/');
  });

  test('Continue continues it as a No project chat in its own folder, and nothing before that', async () => {
    adoptOrchestrationSession.mockClear();
    adoptOrchestrationSession.mockResolvedValue({ threadId: 'continued' });
    const onAdopted = vi.fn();
    await renderAttached({
      presentation: 'chat',
      onAdopted,
      session: { projectSlug: undefined, cwd: '/work/scratch/app' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'carry on' },
    });
    expect(
      screen.getByTestId('attached-continue-notice').textContent,
    ).toContain('the agent works only in /work/scratch/app.');
    expect(adoptOrchestrationSession).not.toHaveBeenCalled();
    fireEvent.click(continueButton());
    await waitFor(() => expect(onAdopted).toHaveBeenCalled());
    expect(adoptOrchestrationSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceThreadId: 'external:claude:raw-thread-id',
        target: { kind: 'own-folder' },
      }),
    );
  });

  test('a started continuation cannot be requested twice', async () => {
    adoptOrchestrationSession.mockClear();
    adoptOrchestrationSession.mockResolvedValue({ threadId: 'continued' });
    const onAdopted = vi.fn();
    // Activity's host passes no `continuationCreated`; the view must guard
    // itself until the host swaps it for the continued session.
    await renderAttached({
      onAdopted,
      session: { projectSlug: undefined, cwd: '/work/scratch/app' },
    });
    sendFromComposer('carry on');
    await waitFor(() => expect(onAdopted).toHaveBeenCalledTimes(1));
    expect(onAdopted).toHaveBeenCalledWith(
      { threadId: 'continued' },
      expect.any(Number),
      'carry on',
    );
    expect(adoptOrchestrationSession).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'own-folder' } }),
    );
    const composer = screen.getByRole('textbox', {
      name: 'Message',
    }) as HTMLTextAreaElement;
    expect(composer.disabled).toBe(true);
    fireEvent.keyDown(composer, { key: 'Enter' });
    // Continued: the action is gone until the host swaps this reader out.
    expect(
      screen.queryByRole('button', { name: 'Continue in Station' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(adoptOrchestrationSession).toHaveBeenCalledTimes(1);
  });

  test('an ambiguous conversation names its candidates, not No project', async () => {
    await renderAttached({
      session: {
        projectSlug: undefined,
        projectAttribution: { state: 'ambiguous', candidates: ['a', 'b'] },
      },
    });
    expect(continueButton().disabled).toBe(false);
    expect(screen.queryByTestId('attached-continuation-no-project')).toBeNull();
  });

  test('a refusal Station will repeat is shown in its own words, with no retry', async () => {
    adoptOrchestrationSession.mockReset();
    const refusal =
      'Station will not continue this conversation as a No project chat in /work/app: it is outside your home folder. A No project chat may only work in a folder inside your home folder. Add a project for that folder, or keep working in the original app.';
    adoptOrchestrationSession.mockRejectedValue(
      new AdoptSessionError({
        failureClass: 'certain-response',
        message: `Station rejected the continuation request (HTTP 400). ${refusal}`,
        retryable: false,
        status: 400,
        refusal,
      }),
    );
    await renderAttached({
      presentation: 'chat',
      session: { projectSlug: undefined, cwd: '/work/app' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'carry on' },
    });
    fireEvent.click(continueButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(refusal);
    const action = continueButton();
    expect(action.disabled).toBe(true);
    fireEvent.click(action);
    expect(adoptOrchestrationSession).toHaveBeenCalledTimes(1);
  });
});

// #3429: an engine that is not set up refused the continuation with a certain,
// retryable reason, and the dialog still said Station was not responding.
describe('a continuation Station settled as not created', () => {
  test('shows the reason Station gave and keeps the retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // The browser's continuation reservation: real store, real storage, and
    // a lock that grants immediately (jsdom has no Web Locks).
    window.localStorage.clear();
    Object.defineProperty(window.navigator, 'locks', {
      configurable: true,
      value: {
        request: async (
          _name: string,
          _options: unknown,
          callback: () => Promise<unknown>,
        ) => callback(),
      },
    });
    starter.unbound = true;
    const reason =
      "Claude Code isn't ready, so no continuation was created (claude prerequisites missing: Claude login). Set up Claude Code, then try again.";
    starter.launch.mockResolvedValueOnce({
      state: 'failed',
      source: { kind: 'session', id: 'external:claude:raw-thread-id' },
      reason,
      retrySafe: true,
    });
    try {
      await renderAttached({ presentation: 'chat' });
      fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
        target: { value: 'carry on' },
      });
      fireEvent.click(continueButton());
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe(
        `Couldn't start the continuation. ${reason}`,
      );
      expect(screen.queryByText(/isn't responding/)).toBeNull();
      expect(screen.queryByText(/continue it twice/)).toBeNull();
      expect(continueButton().disabled).toBe(false);
      expect(starter.launch).toHaveBeenCalledOnce();
    } finally {
      starter.unbound = false;
      vi.restoreAllMocks();
    }
  });
});

test('attached continuation uses the shared newline preference and IME guard', async () => {
  const previous = deviceSettingsStore.get('chatReturnBehavior');
  deviceSettingsStore.set('chatReturnBehavior', 'newline');
  adoptOrchestrationSession.mockClear();
  adoptOrchestrationSession.mockResolvedValue({ threadId: 'continued' });
  // The test above leaves its retry-safe reservation behind; this one starts
  // from no saved continuation request.
  window.localStorage.clear();
  try {
    await renderAttached();
    const editor = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(editor, { target: { value: 'A continuation draft' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    fireEvent.keyDown(editor, {
      key: 'Enter',
      ctrlKey: true,
      isComposing: true,
    });
    expect(adoptOrchestrationSession).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
    await waitFor(() =>
      expect(adoptOrchestrationSession).toHaveBeenCalledTimes(1),
    );
  } finally {
    deviceSettingsStore.set('chatReturnBehavior', previous);
  }
});

// A draft handed over from Activity starts the continuation without a click,
// so it must meet the same guards the Continue action shows.
describe('a handed-over draft obeys the Continue guards', () => {
  test('after a continuation started, a hand-off starts no second one', async () => {
    adoptOrchestrationSession.mockReset();
    adoptOrchestrationSession.mockResolvedValue({ threadId: 'continued' });
    window.localStorage.clear();
    const onAdopted = vi.fn();
    await renderAttached({ presentation: 'chat', onAdopted });
    fireEvent.click(continueButton());
    await waitFor(() => expect(onAdopted).toHaveBeenCalledTimes(1));
    act(() =>
      handOffAttachedContinuation({
        threadId: 'external:claude:raw-thread-id',
        draft: 'again',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adoptOrchestrationSession).toHaveBeenCalledTimes(1);
  });

  test('after a refusal Station will repeat, a hand-off asks again for nothing', async () => {
    adoptOrchestrationSession.mockReset();
    window.localStorage.clear();
    adoptOrchestrationSession.mockRejectedValue(
      new AdoptSessionError({
        failureClass: 'certain-response',
        message: 'refused',
        retryable: false,
        status: 400,
        refusal: 'Station will not continue this here.',
      }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await renderAttached({
        presentation: 'chat',
        session: { projectSlug: undefined, cwd: '/work/app' },
      });
      fireEvent.click(continueButton());
      await screen.findByRole('alert');
      act(() =>
        handOffAttachedContinuation({
          threadId: 'external:claude:raw-thread-id',
          draft: 'again',
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(adoptOrchestrationSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  test('a double hand-off in one tick starts one continuation', async () => {
    adoptOrchestrationSession.mockReset();
    window.localStorage.clear();
    adoptOrchestrationSession.mockResolvedValue({ threadId: 'continued' });
    await renderAttached({ presentation: 'chat' });
    act(() => {
      handOffAttachedContinuation({
        threadId: 'external:claude:raw-thread-id',
        draft: 'one',
      });
      handOffAttachedContinuation({
        threadId: 'external:claude:raw-thread-id',
        draft: 'two',
      });
    });
    await waitFor(() =>
      expect(adoptOrchestrationSession).toHaveBeenCalledTimes(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adoptOrchestrationSession).toHaveBeenCalledTimes(1);
  });
});

describe('the Continue action sits with the conversation’s origin', () => {
  test('a host header slot receives the action; no row of its own is drawn', async () => {
    const slot = document.createElement('span');
    document.body.append(slot);
    try {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      render(
        <QueryClientProvider client={queryClient}>
          <PreviewProvider>
            <ToastProvider>
              <ConversationHeaderActionSlot.Provider value={slot}>
                <AttachedSessionDetail
                  apiBase="http://station.test"
                  session={
                    {
                      threadId: 'external:claude:raw-thread-id',
                      provider: 'claude',
                      controlMode: 'read-only-attached',
                      attachedSource: {
                        kind: 'claude-transcript',
                        externalSessionId: 'fixture-native-source',
                        affinity: {
                          kind: 'fixture-home',
                          ref: 'verified-fixture-home',
                        },
                      },
                      createdAt: '2026-06-27T00:00:00.000Z',
                      updatedAt: '2026-06-27T00:00:00.000Z',
                      projectSlug: 'station',
                    } as any
                  }
                  onAdopted={vi.fn()}
                  getSelectionIntent={() => 0}
                  events={[]}
                  connected
                  historyLoaded
                  visualViewport={{ style: {} } as any}
                />
              </ConversationHeaderActionSlot.Provider>
            </ToastProvider>
          </PreviewProvider>
        </QueryClientProvider>,
      );
      await waitFor(() =>
        expect(
          within(slot).getByRole('button', { name: 'Continue in Station' }),
        ).toBeTruthy(),
      );
      expect(screen.queryByTestId('attached-continue-bar')).toBeNull();
    } finally {
      slot.remove();
    }
  });

  // The still-running caution is a sentence and two choices: it takes a
  // full row of the content area, never the header's narrow action slot.
  test('with the action in a header slot, the still-running caution sits in the content area', async () => {
    const slot = document.createElement('span');
    document.body.append(slot);
    adoptOrchestrationSession.mockReset();
    try {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const view = render(
        <QueryClientProvider client={queryClient}>
          <PreviewProvider>
            <ToastProvider>
              <ConversationHeaderActionSlot.Provider value={slot}>
                <AttachedSessionDetail
                  apiBase="http://station.test"
                  session={
                    {
                      threadId: 'external:claude:raw-thread-id',
                      provider: 'claude',
                      controlMode: 'read-only-attached',
                      attachedSource: {
                        kind: 'claude-transcript',
                        externalSessionId: 'fixture-native-source',
                        affinity: {
                          kind: 'fixture-home',
                          ref: 'verified-fixture-home',
                        },
                      },
                      attachedSourceActivity: { state: 'active' },
                      createdAt: '2026-06-27T00:00:00.000Z',
                      updatedAt: '2026-06-27T00:00:00.000Z',
                      projectSlug: 'station',
                    } as any
                  }
                  onAdopted={vi.fn()}
                  getSelectionIntent={() => 0}
                  events={[]}
                  connected
                  historyLoaded
                  visualViewport={{ style: {} } as any}
                />
              </ConversationHeaderActionSlot.Provider>
            </ToastProvider>
          </PreviewProvider>
        </QueryClientProvider>,
      );
      const action = await within(slot).findByRole('button', {
        name: 'Continue in Station',
      });
      fireEvent.click(action);
      const warning = await within(view.container).findByTestId(
        'attached-source-active',
      );
      expect(slot.contains(warning)).toBe(false);
      expect(
        within(slot).queryByRole('button', { name: 'Not now' }),
      ).toBeNull();
      await waitFor(() =>
        expect(document.activeElement).toBe(
          within(warning).getByRole('button', { name: 'Continue anyway' }),
        ),
      );
      fireEvent.click(within(warning).getByRole('button', { name: 'Not now' }));
      await waitFor(() => expect(document.activeElement).toBe(action));
      expect(adoptOrchestrationSession).not.toHaveBeenCalled();
    } finally {
      slot.remove();
    }
  });

  test('a disabled Continue names its reason beside it', async () => {
    await renderAttached({ session: { provider: 'bedrock' } });
    const action = continueButton();
    expect(action.disabled).toBe(true);
    const reason = document.getElementById(
      action.getAttribute('aria-describedby') ?? '',
    );
    expect(reason?.textContent).toBe(
      'Station has not established independent continuation support for this engine.',
    );
    expect(
      within(screen.getByTestId('attached-continue-notice')).getByText(
        'Station has not established independent continuation support for this engine.',
      ),
    ).toBe(reason);
  });
});

describe('a source still running in its own harness', () => {
  const sourceActiveRefusal = () =>
    new AdoptSessionError({
      failureClass: 'certain-response',
      message:
        'Still running in Claude Code, so no continuation was created. Continuing now forks it.',
      retryable: true,
      status: 409,
      code: 'continuation_source_active',
    });

  test('an idle source continues in one click, without the override', async () => {
    window.localStorage.clear();
    adoptOrchestrationSession.mockReset();
    adoptOrchestrationSession.mockResolvedValue({ threadId: 'continued' });
    await renderAttached({
      presentation: 'chat',
      session: { attachedSourceActivity: { state: 'idle' } },
    });
    fireEvent.click(continueButton());
    await waitFor(() =>
      expect(adoptOrchestrationSession).toHaveBeenCalledOnce(),
    );
    expect(adoptOrchestrationSession.mock.calls[0][0]).not.toHaveProperty(
      'continueWhileSourceActive',
    );
    expect(screen.queryByTestId('attached-source-active')).toBeNull();
  });

  test('an active source warns inline; Not now continues nothing and Continue anyway sends the override', async () => {
    window.localStorage.clear();
    adoptOrchestrationSession.mockReset();
    adoptOrchestrationSession.mockResolvedValue({ threadId: 'continued' });
    const onAdopted = vi.fn();
    await renderAttached({
      presentation: 'chat',
      onAdopted,
      session: { attachedSourceActivity: { state: 'active' } },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'carry on' },
    });
    fireEvent.click(continueButton());
    const warning = await screen.findByTestId('attached-source-active');
    expect(warning.textContent).toContain(
      'Still running in Claude Code. Continuing now forks it',
    );
    // Inline, not a modal.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(adoptOrchestrationSession).not.toHaveBeenCalled();

    fireEvent.click(within(warning).getByRole('button', { name: 'Not now' }));
    expect(screen.queryByTestId('attached-source-active')).toBeNull();
    expect(adoptOrchestrationSession).not.toHaveBeenCalled();

    fireEvent.click(continueButton());
    fireEvent.click(
      within(await screen.findByTestId('attached-source-active')).getByRole(
        'button',
        { name: 'Continue anyway' },
      ),
    );
    await waitFor(() =>
      expect(adoptOrchestrationSession).toHaveBeenCalledOnce(),
    );
    expect(adoptOrchestrationSession.mock.calls[0][0]).toMatchObject({
      continueWhileSourceActive: true,
    });
    await waitFor(() =>
      expect(onAdopted).toHaveBeenCalledWith(
        { threadId: 'continued' },
        expect.any(Number),
        'carry on',
      ),
    );
  });

  // Review item 3: the caution replaces the button that had focus, so focus
  // moves to its first action and comes back to Continue when dismissed; the
  // caution is announced, including when a stale read is refused.
  test('focus moves into the caution and back, and the caution is announced', async () => {
    window.localStorage.clear();
    adoptOrchestrationSession.mockReset();
    await renderAttached({
      presentation: 'chat',
      session: { attachedSourceActivity: { state: 'active' } },
    });
    continueButton().focus();
    fireEvent.click(continueButton());
    const warning = await screen.findByTestId('attached-source-active');
    const status = within(warning).getByRole('status');
    expect(status.textContent).toContain('Still running in Claude Code');
    const anyway = within(warning).getByRole('button', {
      name: 'Continue anyway',
    });
    await waitFor(() => expect(document.activeElement).toBe(anyway));
    expect(anyway.getAttribute('aria-describedby')).toBe(status.id);

    fireEvent.click(within(warning).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(document.activeElement).toBe(continueButton()));
  });

  // Delta review item 5: Continue anyway removes the caution that had focus;
  // when that request then fails, focus lands on the retry, not the page.
  test('a failed Continue anyway leaves focus on Continue in Station', async () => {
    window.localStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    adoptOrchestrationSession.mockReset();
    adoptOrchestrationSession.mockRejectedValueOnce(
      new AdoptSessionError({
        failureClass: 'certain-response',
        message: 'Station rejected the continuation request (HTTP 500).',
        retryable: true,
        status: 500,
      }),
    );
    try {
      await renderAttached({
        presentation: 'chat',
        session: { attachedSourceActivity: { state: 'active' } },
      });
      fireEvent.click(continueButton());
      const warning = await screen.findByTestId('attached-source-active');
      const anyway = within(warning).getByRole('button', {
        name: 'Continue anyway',
      });
      await waitFor(() => expect(document.activeElement).toBe(anyway));
      fireEvent.click(anyway);
      await screen.findByRole('alert');
      await waitFor(() =>
        expect(document.activeElement).toBe(continueButton()),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  // Review: with the caution already showing, Continue again moves focus
  // back into it rather than doing nothing visible.
  test('pressing Continue again while the caution shows moves focus into it', async () => {
    window.localStorage.clear();
    adoptOrchestrationSession.mockReset();
    await renderAttached({
      presentation: 'chat',
      session: { attachedSourceActivity: { state: 'active' } },
    });
    fireEvent.click(continueButton());
    const warning = await screen.findByTestId('attached-source-active');
    const anyway = within(warning).getByRole('button', {
      name: 'Continue anyway',
    });
    await waitFor(() => expect(document.activeElement).toBe(anyway));
    continueButton().focus();
    expect(document.activeElement).toBe(continueButton());
    fireEvent.click(continueButton());
    await waitFor(() => expect(document.activeElement).toBe(anyway));
    expect(adoptOrchestrationSession).not.toHaveBeenCalled();
  });

  test('a refusal of a stale read is announced and takes focus', async () => {
    window.localStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    adoptOrchestrationSession.mockReset();
    adoptOrchestrationSession.mockRejectedValueOnce(sourceActiveRefusal());
    try {
      await renderAttached({
        presentation: 'chat',
        session: { attachedSourceActivity: { state: 'idle' } },
      });
      fireEvent.click(continueButton());
      const warning = await screen.findByTestId('attached-source-active');
      expect(within(warning).getByRole('status')).toBeTruthy();
      await waitFor(() =>
        expect(document.activeElement).toBe(
          within(warning).getByRole('button', { name: 'Continue anyway' }),
        ),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  test("Station's own re-check opens the same warning when this read said idle", async () => {
    window.localStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    adoptOrchestrationSession.mockReset();
    adoptOrchestrationSession
      .mockRejectedValueOnce(sourceActiveRefusal())
      .mockResolvedValueOnce({ threadId: 'continued' });
    try {
      await renderAttached({
        presentation: 'chat',
        session: { attachedSourceActivity: { state: 'idle' } },
      });
      fireEvent.click(continueButton());
      const warning = await screen.findByTestId('attached-source-active');
      // The refusal is the warning, not a failure.
      expect(screen.queryByRole('alert')).toBeNull();
      fireEvent.click(
        within(warning).getByRole('button', { name: 'Continue anyway' }),
      );
      await waitFor(() =>
        expect(adoptOrchestrationSession).toHaveBeenCalledTimes(2),
      );
      expect(adoptOrchestrationSession.mock.calls[1][0]).toMatchObject({
        continueWhileSourceActive: true,
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  test('a first continuation through Starter Work carries the refusal and the override the same way', async () => {
    window.localStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    Object.defineProperty(window.navigator, 'locks', {
      configurable: true,
      value: {
        request: async (
          _name: string,
          _options: unknown,
          callback: () => Promise<unknown>,
        ) => callback(),
      },
    });
    starter.unbound = true;
    starter.launch.mockReset();
    starter.launch
      .mockResolvedValueOnce({
        state: 'failed',
        source: { kind: 'session', id: 'external:claude:raw-thread-id' },
        reason:
          'Still running in Claude Code, so no continuation was created. Continuing now forks it.',
        retrySafe: true,
        code: 'continuation_source_active',
      })
      .mockResolvedValueOnce({
        state: 'continued',
        source: { kind: 'session', id: 'external:claude:raw-thread-id' },
        session: { threadId: 'continued' },
        correlation: { state: 'not_verified', reason: 'fixture' },
        evidence: { state: 'NOT_VERIFIED', reason: 'fixture' },
      });
    try {
      await renderAttached({ presentation: 'chat' });
      fireEvent.click(continueButton());
      const warning = await screen.findByTestId('attached-source-active');
      expect(screen.queryByRole('alert')).toBeNull();
      fireEvent.click(
        within(warning).getByRole('button', { name: 'Continue anyway' }),
      );
      await waitFor(() => expect(starter.launch).toHaveBeenCalledTimes(2));
      expect(starter.launch.mock.calls[0][0]).not.toHaveProperty(
        'continueWhileSourceActive',
      );
      expect(starter.launch.mock.calls[1][0]).toMatchObject({
        continueWhileSourceActive: true,
        operationId: starter.launch.mock.calls[0][0].operationId,
      });
    } finally {
      starter.unbound = false;
      vi.restoreAllMocks();
    }
  });

  test('a draft handed over from Activity waits at the warning instead of continuing', async () => {
    window.localStorage.clear();
    adoptOrchestrationSession.mockReset();
    handOffAttachedContinuation({
      threadId: 'external:claude:raw-thread-id',
      draft: 'From Activity',
    });
    await renderAttached({
      presentation: 'chat',
      session: { attachedSourceActivity: { state: 'active' } },
    });
    await screen.findByTestId('attached-source-active');
    expect(adoptOrchestrationSession).not.toHaveBeenCalled();
  });
});
