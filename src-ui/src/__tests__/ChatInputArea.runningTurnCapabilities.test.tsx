// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react';
import type React from 'react';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { ChatInputArea } from '../components/chat/ChatInputArea';
import type { FileAttachment } from '../types';

// The paperclip's own component needs the preview provider; what this file
// proves is what the composer hands it, so the stub renders that decision as
// the button a person would meet. The real control is exercised in
// tests/composer-capabilities.spec.ts.
vi.mock('../components/chat/FileAttachmentInput', () => ({
  FileAttachmentInput: ({
    disabled,
    onFilesSelected,
  }: {
    disabled?: boolean;
    onFilesSelected: (files: File[]) => void;
  }) => (
    <button
      type="button"
      aria-label="Attach files"
      disabled={disabled}
      onClick={() => onFilesSelected([])}
    />
  ),
}));
vi.mock('../components/conversation-stats/ConversationStats', () => ({
  ContextPercentage: () => null,
}));

let phone = false;
// The composer loads the paperclip lazily; load it once up front so a slow
// first import does not decide the first test.
beforeAll(async () => {
  await import('../components/chat/FileAttachmentInput');
});
beforeEach(() => {
  phone = false;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: phone && query.includes('max-width'),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      media: query,
      onchange: null,
    })),
  });
});

const FILE: FileAttachment = {
  id: 'file-1',
  name: 'notes.txt',
  type: 'text/plain',
  size: 12,
  data: 'data:text/plain;base64,aGVsbG8=',
};

function renderComposer(
  overrides: Partial<React.ComponentProps<typeof ChatInputArea>> = {},
) {
  const props = {
    input: '',
    attachments: [],
    textareaRef: { current: null },
    disabled: false,
    turnInFlight: true,
    busyFollowUp: 'queue',
    onQueueFollowUp: vi.fn(async () => {}),
    modelSupportsAttachments: true,
    fontSize: 14,
    dockHeight: 600,
    canModelSelect: false,
    availableModels: [],
    modelQuery: null,
    commandQuery: null,
    slashCommands: [],
    onInputChange: vi.fn(),
    onSend: vi.fn(async () => {}),
    onCancel: vi.fn(),
    onClearInput: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onClearAttachments: vi.fn(),
    onModelSelect: vi.fn(),
    onModelReset: vi.fn(),
    onModelClose: vi.fn(),
    onModelOpen: vi.fn(),
    onModelRuntimeOptionChange: vi.fn(),
    onApprovalModeChange: vi.fn(),
    onCommandSelect: vi.fn(async () => {}),
    onCommandClose: vi.fn(),
    onHistoryUp: vi.fn(),
    onHistoryDown: vi.fn(),
    updateFromInput: vi.fn(),
    closeAll: vi.fn(),
    voiceState: 'idle',
    voiceSupported: true,
    onVoiceStart: vi.fn(),
    onVoiceStop: vi.fn(),
    ...overrides,
  } as React.ComponentProps<typeof ChatInputArea>;
  render(<ChatInputArea {...props} />);
  return props;
}

describe('ChatInputArea: one capability contract while a turn runs', () => {
  test('dictation and the paperclip stay usable during a running turn', async () => {
    const props = renderComposer();
    const mic = screen.getByRole('button', { name: 'Speak message' });
    expect((mic as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(mic);
    expect(props.onVoiceStart).toHaveBeenCalledTimes(1);
    const attach = await screen.findByRole(
      'button',
      { name: 'Attach files' },
      { timeout: 10_000 },
    );
    expect((attach as HTMLButtonElement).disabled).toBe(false);
  });

  test('a composer that cannot take input still refuses both', async () => {
    renderComposer({ disabled: true });
    expect(
      screen
        .getByRole('button', { name: 'Speak message' })
        .getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      (
        screen.getByRole('button', {
          name: 'Attach files',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test('files in a running turn’s draft wait, say why, and offer removal', () => {
    const props = renderComposer({ input: 'with a file', attachments: [FILE] });
    const composer = screen.getByRole('group', { name: 'Message composer' });
    expect(
      within(composer).getByText(
        'Files can’t be added to a running turn: Steer and Queue carry text only. Send when this turn ends, or remove them.',
      ),
    ).toBeTruthy();
    const send = screen.getByRole('button', { name: 'Send' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole('textbox'), {
      key: 'Enter',
      ctrlKey: true,
    });
    expect(props.onQueueFollowUp).not.toHaveBeenCalled();
    expect(props.onSend).not.toHaveBeenCalled();
    fireEvent.click(
      within(composer).getByRole('button', { name: 'Remove attachments' }),
    );
    expect(props.onClearAttachments).toHaveBeenCalledTimes(1);
  });

  test('the same draft sends once no turn is running', () => {
    renderComposer({
      input: 'with a file',
      attachments: [FILE],
      turnInFlight: false,
    });
    expect(screen.queryByText(/running turn/)).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  test('an attachment’s own block outranks the running-turn reason', () => {
    renderComposer({
      input: 'with a file',
      attachments: [FILE],
      sendBlockedReason: 'An upload did not finish. Retry it or remove it.',
    });
    expect(
      screen.getByText('An upload did not finish. Retry it or remove it.'),
    ).toBeTruthy();
    expect(screen.queryByText(/running turn/)).toBeNull();
  });
});

describe('ChatInputArea: Stop beside the hidden Send', () => {
  const sendGroupOrder = () =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '.chat-input__send-group > button, .chat-input__send-group > .chat-input__submit-controls',
      ),
    ].map((element) =>
      element.classList.contains('chat-input__submit-controls')
        ? 'submit'
        : (element.getAttribute('aria-label') ?? ''),
    );

  test('on a phone Stop follows the Send/Queue it waits beside', () => {
    phone = true;
    renderComposer();
    expect(sendGroupOrder()).toEqual(['submit', 'Stop the current turn']);
    expect(
      document
        .querySelector('.chat-input__submit-controls')
        ?.hasAttribute('data-concealed'),
    ).toBe(true);
  });

  test('on a desktop Stop leads, where Send is always shown', () => {
    renderComposer();
    expect(sendGroupOrder()).toEqual(['Stop the current turn', 'submit']);
  });
});

describe('ChatInputArea: Agent chip identity', () => {
  test('the route is its own part of the chip and stays in the accessible name', () => {
    renderComposer({
      agentLabel: 'Codex',
      agentRoute: 'via model-proxy (home-server · Claude + Codex)',
      onOpenAgentHandoff: vi.fn(),
      turnInFlight: false,
    });
    const chip = screen.getByRole('button', { name: /^Agent: / });
    expect(chip.getAttribute('aria-label')).toBe(
      'Agent: Codex · via model-proxy (home-server · Claude + Codex). Change Agent',
    );
    const name = chip.querySelector('.chat-input__agent-name');
    expect(name?.firstChild?.textContent).toBe('Codex');
    expect(chip.querySelector('.chat-input__agent-route')?.textContent).toBe(
      ' · via model-proxy (home-server · Claude + Codex)',
    );
  });
});
