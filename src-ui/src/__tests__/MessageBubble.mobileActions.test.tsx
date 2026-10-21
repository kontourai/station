/**
 * @vitest-environment jsdom
 *
 * Phone rows put Copy beside the row's ⋯ trigger, for the user's message and
 * the answer alike, and the ⋯ sheet no longer repeats it. Uses the REAL
 * MessageBubble and MessageDetails sheet; only dependencies that would drag in
 * markdown or auth are mocked.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ForkTurnSource } from '../components/chat/fork-turn-source';
import { precedingForkSource } from '../components/chat/fork-turn-source';
import type { ChatMessage } from '../types';

const { mobile } = vi.hoisted(() => ({ mobile: { current: true } }));

// The file chip reads attachment bytes through the host; this suite asks
// only which actions a row offers.
vi.mock('../components/chat/FilePartPreview', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  FilePartPreview: ({ part }: { part: { name?: string } }) => (
    <span>{part.name}</span>
  ),
}));
vi.mock('../hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hooks/useIsMobile')>()),
  useIsMobile: () => mobile.current,
}));
vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: string }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => null }));
vi.mock('../highlight/highlight-client', () => ({
  highlightCode: () => new Promise<string>(() => {}),
}));
vi.mock('../components/chat/message-bubble/MessageRating', () => ({
  MessageRating: () => (
    <span className="message__rating">
      <button type="button" aria-label="Good response" />
    </span>
  ),
}));
vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => null,
}));

const { MessageBubble } = await import('../components/chat/MessageBubble');
const { CopyGlyph } = await import('../components/icons/Glyph');
const { markdownCodeComponents } = await import(
  '../components/chat/HighlightedCodeBlock'
);

function withQueryClient(ui: ReactElement) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {ui}
    </QueryClientProvider>
  );
}

const envelope = {
  envelopeVersion: 1,
  sessionId: 'thread-1',
  turnId: 'turn-7',
  outcome: 'completed',
  observedAt: '2026-08-01T00:00:00.000Z',
  engine: {
    state: 'observed',
    value: { provider: 'codex' },
    observedFrom: [{ eventId: 'e1', method: 'turn.completed' }],
  },
  requestedModel: { state: 'unavailable', reason: 'not-reported-by-engine' },
  reportedModel: { state: 'unavailable', reason: 'not-reported-by-engine' },
  tools: { state: 'unavailable', reason: 'not-reported-by-engine' },
  usage: { state: 'unavailable', reason: 'not-reported-by-engine' },
  routingReceipt: { state: 'unavailable', reason: 'not-captured-by-station' },
  sources: { state: 'unavailable', reason: 'not-captured-by-station' },
  trustReport: { state: 'unavailable', reason: 'not-captured-by-station' },
};

function renderRow(
  msg: ChatMessage,
  extra: {
    onNewChatFromMessage?: (text: string) => void;
    userForkSource?: ForkTurnSource | null;
    onForkFromTurn?: (source: ForkTurnSource) => void;
  } = {},
) {
  const onCopy = vi.fn();
  render(
    withQueryClient(
      <MessageBubble
        msg={msg}
        idx={0}
        activeSession={{
          id: 'thread-1',
          agentSlug: 'agent',
          agentName: 'Station',
          messageCount: 1,
        }}
        agents={[]}
        chatFontSize={14}
        showReasoning={false}
        showToolDetails={false}
        onCopy={onCopy}
        {...extra}
      />,
    ),
  );
  return { onCopy };
}

/** Copy is an icon: named for assistive tech, with no visible text. */
function expectIconOnly(copy: HTMLElement, name: string) {
  expect(copy.getAttribute('aria-label')).toBe(name);
  expect(copy.getAttribute('title')).toBe(name);
  expect(copy.textContent?.trim()).toBe('');
  const glyph = copy.querySelector('svg');
  expect(glyph?.getAttribute('aria-hidden')).toBe('true');
}

/** The row's one Copy control sits in the same group as, and before, its ⋯. */
function expectCopyBesideTrigger(triggerName: string, copyName: string) {
  const copy = screen.getByRole('button', { name: copyName });
  expectIconOnly(copy, copyName);
  const trigger = screen.getByRole('button', { name: triggerName });
  expect(copy.parentElement).toBe(trigger.parentElement);
  expect(
    copy.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  return { copy, trigger };
}

describe('MessageBubble phone copy and details actions', () => {
  it('puts Copy beside the ⋯ of a user message, and the sheet does not repeat it', () => {
    mobile.current = true;
    const { onCopy } = renderRow(
      { role: 'user', content: 'Ship the fix?' },
      { onNewChatFromMessage: () => {} },
    );

    const { copy, trigger } = expectCopyBesideTrigger(
      'Your message actions',
      'Copy your message',
    );
    fireEvent.click(copy);
    expect(onCopy).toHaveBeenCalledWith('Ship the fix?');

    fireEvent.click(trigger);
    const sheet = screen.getByRole('dialog', { name: 'Your message actions' });
    expect(within(sheet).queryByRole('button', { name: /^Copy/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Copy/ })).toHaveLength(1);
  });

  it('puts Copy beside the ⋯ of a completed answer, and its sheet keeps the other actions', async () => {
    mobile.current = true;
    const { onCopy } = renderRow({
      role: 'assistant',
      content: 'Here is the answer.',
      turnId: 'turn-7',
      answerEligible: true,
      provenance: envelope,
    });

    const { copy, trigger } = expectCopyBesideTrigger(
      'Answer details and actions',
      'Copy answer',
    );
    fireEvent.click(copy);
    expect(onCopy).toHaveBeenCalledWith('Here is the answer.');

    fireEvent.click(trigger);
    const sheet = screen.getByRole('dialog', {
      name: 'Answer details and actions',
    });
    expect(
      await within(sheet).findByRole('button', { name: 'More answer actions' }),
    ).toBeTruthy();
    expect(
      within(sheet).getByRole('button', { name: 'Good response' }),
    ).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: /^Copy/ })).toBeNull();
  });

  it('keeps an answer without a turn footer to one Copy, outside its sheet', () => {
    mobile.current = true;
    const { onCopy } = renderRow({
      role: 'assistant',
      content: 'A live answer.',
    });

    const { copy, trigger } = expectCopyBesideTrigger(
      'Answer details and actions',
      'Copy answer',
    );
    fireEvent.click(copy);
    expect(onCopy).toHaveBeenCalledWith('A live answer.');

    fireEvent.click(trigger);
    const sheet = screen.getByRole('dialog', {
      name: 'Answer details and actions',
    });
    expect(
      within(sheet).getByRole('button', { name: 'Good response' }),
    ).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: /^Copy/ })).toBeNull();
  });

  it('offers no ⋯ for a user message whose sheet would be empty', () => {
    mobile.current = true;
    renderRow({ role: 'user', content: 'Just this.' });

    expectIconOnly(
      screen.getByRole('button', { name: 'Copy your message' }),
      'Copy your message',
    );
    expect(
      screen.queryByRole('button', { name: 'Your message actions' }),
    ).toBeNull();
  });

  it('leaves the desktop row with its footer copy and no phone controls', () => {
    mobile.current = false;
    try {
      const { onCopy } = renderRow({
        role: 'assistant',
        content: 'Desktop answer.',
        turnId: 'turn-7',
        provenance: envelope,
      });

      const copy = screen.getByRole('button', { name: 'Copy answer' });
      expectIconOnly(copy, 'Copy answer');
      expect(copy.closest('.turn-footer__actions')).not.toBeNull();
      expect(
        screen.queryByRole('button', { name: 'Answer details and actions' }),
      ).toBeNull();
      fireEvent.click(copy);
      expect(onCopy).toHaveBeenCalledWith('Desktop answer.');
    } finally {
      mobile.current = true;
    }
  });

  it('gives a desktop user message the same copy icon, beside its overflow menu', async () => {
    mobile.current = false;
    try {
      const { onCopy } = renderRow(
        { role: 'user', content: 'Desktop question.' },
        { onNewChatFromMessage: () => {} },
      );

      const copy = screen.getByRole('button', { name: 'Copy your message' });
      expectIconOnly(copy, 'Copy your message');
      const menu = await screen.findByRole('button', {
        name: 'More message actions',
      });
      expect(copy.closest('.message__user-actions')).not.toBeNull();
      expect(menu.closest('.message__user-actions')).toBe(
        copy.closest('.message__user-actions'),
      );
      fireEvent.click(copy);
      expect(onCopy).toHaveBeenCalledWith('Desktop question.');
    } finally {
      mobile.current = true;
    }
  });

  it('gives a desktop user message with no other actions a copy icon too', () => {
    mobile.current = false;
    try {
      renderRow({ role: 'user', content: 'Plain question.' });
      expectIconOnly(
        screen.getByRole('button', { name: 'Copy your message' }),
        'Copy your message',
      );
    } finally {
      mobile.current = true;
    }
  });

  it('draws every message-actions trigger with the same centred ⋯', async () => {
    const glyphOf = (button: HTMLElement) => {
      const glyph = button.querySelector('[aria-hidden="true"]');
      return { text: button.textContent, hidden: glyph?.textContent };
    };
    const centred = { text: '⋯', hidden: '⋯' };

    mobile.current = true;
    renderRow(
      { role: 'user', content: 'Q?' },
      { onNewChatFromMessage: () => {} },
    );
    expect(
      glyphOf(screen.getByRole('button', { name: 'Your message actions' })),
    ).toEqual(centred);
    cleanup();

    mobile.current = false;
    try {
      renderRow(
        { role: 'user', content: 'Q?' },
        { onNewChatFromMessage: () => {} },
      );
      expect(
        glyphOf(
          await screen.findByRole('button', { name: 'More message actions' }),
        ),
      ).toEqual(centred);
      cleanup();
      renderRow({
        role: 'assistant',
        content: 'A.',
        turnId: 'turn-7',
        answerEligible: true,
        provenance: envelope,
      });
      expect(
        glyphOf(
          await screen.findByRole('button', { name: 'More answer actions' }),
        ),
      ).toEqual(centred);
    } finally {
      mobile.current = true;
    }
  });

  it('draws every copy control with the one shared CopyGlyph', () => {
    const pathOf = (root: Element | null) =>
      root?.querySelector('svg path')?.getAttribute('d');
    const reference = pathOf(render(<CopyGlyph />).container);
    expect(reference).toBeTruthy();
    cleanup();

    const copyPaths: Array<string | null | undefined> = [];
    mobile.current = true;
    renderRow({ role: 'user', content: 'Phone question.' });
    copyPaths.push(
      pathOf(screen.getByRole('button', { name: 'Copy your message' })),
    );
    cleanup();
    mobile.current = false;
    try {
      renderRow({ role: 'user', content: 'Desktop question.' });
      copyPaths.push(
        pathOf(screen.getByRole('button', { name: 'Copy your message' })),
      );
      cleanup();
      renderRow({
        role: 'assistant',
        content: 'Desktop answer.',
        turnId: 'turn-7',
        provenance: envelope,
      });
      copyPaths.push(
        pathOf(screen.getByRole('button', { name: 'Copy answer' })),
      );
      cleanup();
      renderRow({ role: 'assistant', content: 'Footerless answer.' });
      copyPaths.push(
        pathOf(screen.getByRole('button', { name: 'Copy answer' })),
      );
      cleanup();
    } finally {
      mobile.current = true;
    }

    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    try {
      const Code = markdownCodeComponents.code;
      render(<Code className="language-ts">{'const a = 1;\n'}</Code>);
      copyPaths.push(pathOf(screen.getByRole('button', { name: 'Copy' })));
    } finally {
      vi.unstubAllGlobals();
    }

    expect(copyPaths).toEqual(Array(5).fill(reference));
  });

  it("puts a user message's Task pin and its actions on the sheet's one row, with no second ⋯", async () => {
    mobile.current = true;
    renderRow(
      {
        role: 'user',
        content: 'Pin me.',
        sourceEventId: 'event-1',
        sessionId: 'thread-1',
        turnId: 'turn-1',
      },
      { onNewChatFromMessage: () => {} },
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Your message actions' }),
    );
    const sheet = screen.getByRole('dialog', { name: 'Your message actions' });
    const summary = sheet.querySelector('.message-details__summary');
    // The sheet IS the menu's surface: its rows are listed in place, as
    // plain buttons in a group (no menu roles without menu keyboard
    // behaviour).
    const item = await within(sheet).findByRole('button', {
      name: 'New chat from this message',
    });
    expect(within(sheet).queryByRole('menu')).toBeNull();
    expect(within(sheet).queryByRole('menuitem')).toBeNull();
    expect(within(sheet).getByRole('group', { name: 'Message actions' })).toBe(
      item.parentElement,
    );
    expect(item.closest('.message-details__actions')?.parentElement).toBe(
      summary,
    );
    expect(
      within(sheet).queryByRole('button', { name: 'More message actions' }),
    ).toBeNull();
    expect(
      sheet
        .querySelector('.message__task-input-action')
        ?.closest('.message-details__lead')?.parentElement,
    ).toBe(summary);
  });

  it("lists a not-sent message's Discard in the phone sheet itself, one level deep", async () => {
    mobile.current = true;
    const { activeChatsStore } = await import('../contexts/active-chats-store');
    activeChatsStore.initChat('thread-1', {
      agentSlug: 'agent',
      agentName: 'Station',
      title: 'Not sent',
    });
    activeChatsStore.updateChat('thread-1', {
      outboundQueuedTurns: [
        {
          clientTurnId: 'refused-key',
          content: 'Refused.',
          createdAt: 1,
          status: 'failed',
        },
      ],
    });
    try {
      renderRow({
        role: 'user',
        content: 'Refused.',
        clientId: 'refused-key',
      } as ChatMessage);
      fireEvent.click(
        screen.getByRole('button', { name: 'Your message actions' }),
      );
      const sheet = screen.getByRole('dialog', {
        name: 'Your message actions',
      });
      expect(
        await within(sheet).findByRole('button', {
          name: 'Discard unsent message',
        }),
      ).toBeTruthy();
      expect(
        within(sheet).queryByRole('button', { name: 'More message actions' }),
      ).toBeNull();
    } finally {
      activeChatsStore.removeChat('thread-1');
    }
  });

  it('opens a user sheet whose only item is the Task pin', () => {
    mobile.current = true;
    renderRow({
      role: 'user',
      content: 'Only pin.',
      sourceEventId: 'event-1',
      sessionId: 'thread-1',
      turnId: 'turn-1',
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Your message actions' }),
    );
    const sheet = screen.getByRole('dialog', { name: 'Your message actions' });
    expect(sheet.querySelector('.message__task-input-action')).not.toBeNull();
  });

  describe('a user message with a fork source but no fork handler', () => {
    const question = { role: 'user' as const, content: 'Fork me?' };
    // A fork source is the completed answer BEFORE this message.
    const forkSource = precedingForkSource(
      [
        { role: 'user', content: 'First.' },
        {
          role: 'assistant',
          content: 'Done',
          turnId: 'turn-ok',
          answerEligible: true,
          agentSlug: 'agent',
          sessionId: 'thread-1',
        },
        question,
      ] as ChatMessage[],
      2,
    );

    it('has a fork source to offer (fixture guard)', () => {
      expect(forkSource).toBeTruthy();
    });

    it('draws no desktop ⋯ whose menu would be empty', async () => {
      mobile.current = false;
      try {
        // Positive control first: with the handler the menu loads (and its
        // lazy chunk is now cached, so the absence below is not just a
        // menu that has not loaded yet).
        renderRow(question, {
          userForkSource: forkSource,
          onForkFromTurn: () => {},
        });
        expect(
          await screen.findByRole('button', { name: 'More message actions' }),
        ).toBeTruthy();
        cleanup();

        renderRow(question, { userForkSource: forkSource });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        });
        expect(
          screen.getByRole('button', { name: 'Copy your message' }),
        ).toBeTruthy();
        expect(
          screen.queryByRole('button', { name: 'More message actions' }),
        ).toBeNull();
      } finally {
        mobile.current = true;
      }
    });

    it('draws no phone ⋯ for a sheet that would hold only an empty menu', () => {
      mobile.current = true;
      renderRow(question, { userForkSource: forkSource });
      expect(
        screen.queryByRole('button', { name: 'Your message actions' }),
      ).toBeNull();
      cleanup();
      // Positive control: with the handler the fork entry exists, so the ⋯
      // is offered.
      renderRow(question, {
        userForkSource: forkSource,
        onForkFromTurn: () => {},
      });
      expect(
        screen.getByRole('button', { name: 'Your message actions' }),
      ).toBeTruthy();
    });
  });

  it("lists a desktop user message's Task pin in its ⋯ menu, not as a standing button", async () => {
    mobile.current = false;
    try {
      renderRow({
        role: 'user',
        content: 'Pin me on desktop.',
        sourceEventId: 'event-1',
        sessionId: 'thread-1',
        turnId: 'turn-1',
      });
      expect(document.querySelector('.message__task-input-action')).toBeNull();
      expect(
        screen.queryByRole('button', { name: 'Add input to Task' }),
      ).toBeNull();
      fireEvent.click(
        await screen.findByRole('button', { name: 'More message actions' }),
      );
      const menu = await screen.findByRole('menu', { name: 'Message actions' });
      fireEvent.click(
        await within(menu).findByRole('menuitem', {
          name: 'Add input to Task',
        }),
      );
      // The picker opens from the menu and stays open after the menu hides.
      expect(
        await screen.findByRole('dialog', { name: /Add input to Task/ }),
      ).toBeTruthy();
      expect(menu.hidden).toBe(true);
    } finally {
      mobile.current = true;
    }
  });

  it('an image-only message keeps its desktop ⋯ with Add input to Task', async () => {
    mobile.current = false;
    try {
      renderRow({
        role: 'user',
        content: '',
        contentParts: [
          {
            type: 'file',
            mediaType: 'image/png',
            name: 'shot.png',
          },
        ],
        sourceEventId: 'event-2',
        sessionId: 'thread-1',
        turnId: 'turn-2',
      } as never);
      fireEvent.click(
        await screen.findByRole('button', { name: 'More message actions' }),
      );
      const menu = await screen.findByRole('menu', { name: 'Message actions' });
      expect(
        await within(menu).findByRole('menuitem', {
          name: 'Add input to Task',
        }),
      ).toBeTruthy();
      // The text actions need text: none is offered for an image.
      expect(
        within(menu).queryByRole('menuitem', { name: /new chat/i }),
      ).toBeNull();
    } finally {
      mobile.current = true;
    }
  });
});
