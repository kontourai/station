// @vitest-environment jsdom

import { CHAT_INPUT_MAX_CHARS } from '@shared/chat-input-limits';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { createRef, useState } from 'react';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { ChatInputArea } from '../components/chat/ChatInputArea';

vi.mock('../components/conversation-stats/ConversationStats', () => ({
  ContextPercentage: () => null,
}));

vi.mock('../components/chat/FileAttachmentInput', () => ({
  FileAttachmentInput: () => null,
}));

vi.mock('../components/ModelSelector', () => ({
  ModelSelectorAutocomplete: () => null,
}));

vi.mock('../components/chat/SlashCommandSelector', () => ({
  SlashCommandSelector: () => null,
}));

vi.mock('../components/voice/VoiceOrb', () => ({
  VoiceOrb: () => null,
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      media: '',
      onchange: null,
    })),
  });
});

function renderChatInputArea(overrides: Record<string, unknown> = {}) {
  const props = {
    agentSlug: 'station',
    conversationId: undefined,
    messageCount: 0,
    input: 'hello',
    attachments: [],
    textareaRef: { current: null },
    disabled: false,
    isSending: false,
    turnInFlight: false,
    modelSupportsAttachments: true,
    fontSize: 14,
    dockHeight: 600,
    apiBase: 'http://localhost:3242',
    currentModel: undefined,
    canModelSelect: true,
    agentDefaultModel: 'claude-sonnet',
    availableModels: [{ id: 'claude-sonnet', name: 'Claude Sonnet' }],
    modelQuery: null,
    commandQuery: null,
    slashCommands: [],
    onInputChange: vi.fn(),
    onSend: vi.fn(async () => {}),
    onCancel: vi.fn(),
    onClearInput: vi.fn(),
    selectAttachmentFiles: vi.fn(async () => {}),
    attachmentError: null,
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
    onShowStats: vi.fn(),
    updateFromInput: vi.fn(),
    closeAll: vi.fn(),
    ...overrides,
  };

  render(<ChatInputArea {...props} />);
  return props;
}

describe('ChatInputArea', () => {
  test('surfaces a microphone permission failure in the composer', () => {
    renderChatInputArea({
      voiceState: 'error',
      voiceSupported: true,
      voiceError:
        'Microphone permission was denied. Allow access and try again.',
      onVoiceStart: vi.fn(),
      onVoiceStop: vi.fn(),
    });

    expect(screen.getByRole('alert').textContent).toContain(
      'Microphone permission was denied',
    );
  });

  test('autosizes the textarea to measured content and clamps overflow', () => {
    const { rerender } = render(
      <ChatInputArea {...renderProps({ input: 'one' })} />,
    );
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    let scrollHeight = 220;
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    rerender(<ChatInputArea {...renderProps({ input: 'one\ntwo' })} />);
    expect(textarea.style.height).toBe('160px');
    expect(textarea.style.overflowY).toBe('auto');
    scrollHeight = 40;
    rerender(<ChatInputArea {...renderProps({ input: 'one' })} />);
    expect(textarea.style.height).toBe('40px');
    expect(textarea.style.overflowY).toBe('hidden');
  });

  test('does not send Enter while an IME composition is active', () => {
    const onSend = vi.fn(async () => {});
    render(<ChatInputArea {...renderProps({ onSend })} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  test('honors the native isComposing key signal after composition event ordering', () => {
    const onSend = vi.fn(async () => {});
    render(<ChatInputArea {...renderProps({ onSend })} />);
    fireEvent.keyDown(screen.getByRole('textbox'), {
      key: 'Enter',
      isComposing: true,
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  test('routes a workspace-refused composer to the existing new-chat flow without sending', async () => {
    const onSend = vi.fn(async () => {});
    const onStartNewChat = vi.fn(async () => {});
    renderChatInputArea({
      input: 'continue here',
      workspaceRefused: true,
      onSend,
      onStartNewChat,
    });

    const textarea = screen.getByRole('textbox');
    expect(textarea.getAttribute('placeholder')).toBe(
      'This conversation continues from its original workspace — start a new chat to work here',
    );
    fireEvent.change(textarea, { target: { value: 'typed after refusal' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
    expect(onStartNewChat).toHaveBeenCalledWith('continue here', []);
    expect(
      screen.getByRole('button', { name: 'Start new chat' }),
    ).not.toBeNull();
  });

  test('keeps the ordinary composer send behavior when no workspace refusal exists', () => {
    const onSend = vi.fn(async () => {});
    const onStartNewChat = vi.fn(async () => {});
    renderChatInputArea({ onSend, onStartNewChat });

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onStartNewChat).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send' })).not.toBeNull();
  });

  test('keeps an unavailable model control focusable and names the reason', () => {
    const props = renderChatInputArea({
      canModelSelect: false,
      modelSelectionReason: 'This Agent reports no selectable models.',
    });

    const model = screen.getByRole('button', {
      name: /Unavailable: This Agent reports no selectable models\./,
    });
    expect(model.getAttribute('aria-disabled')).toBe('true');
    model.focus();
    fireEvent.click(model);
    expect(document.activeElement).toBe(model);
    expect(props.onModelOpen).not.toHaveBeenCalled();
  });

  // Stop could be pressed again while the first request was
  // still outstanding, submitting a duplicate command and a duplicate receipt.
  test('disables Stop while a stop request is outstanding and says what is pending', () => {
    const props = renderChatInputArea({
      turnInFlight: true,
      stopPending: true,
    });

    const stop = screen.getByRole('button', {
      name: 'Stop requested — waiting for the engine',
    }) as HTMLButtonElement;
    expect(stop.disabled).toBe(true);

    fireEvent.click(stop);
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  test('offers Stop normally while a turn is in flight and no stop is pending', () => {
    const props = renderChatInputArea({ turnInFlight: true });

    const stop = screen.getByRole('button', {
      name: 'Stop the current turn',
    }) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);

    fireEvent.click(stop);
    expect(props.onCancel).toHaveBeenCalled();
  });

  test('opens the model picker when model selection is available', () => {
    const props = renderChatInputArea();

    fireEvent.click(screen.getByRole('button', { name: /^Model/ }));

    expect(props.onModelOpen).toHaveBeenCalled();
    expect(props.onInputChange).not.toHaveBeenCalled();
  });

  test('shows selector values while retaining named controls and keyboard activation', () => {
    const onOpenAgentHandoff = vi.fn();
    const agentHandoffTriggerRef = createRef<HTMLButtonElement>();
    renderChatInputArea({
      agentLabel: 'Codex reviewer',
      onOpenAgentHandoff,
      agentHandoffTriggerRef,
      currentModel: 'claude-sonnet',
    });

    const agent = screen.getByRole('button', {
      name: 'Agent: Codex reviewer. Change Agent',
    });
    expect(agent.textContent).toBe('Codex reviewer');
    expect(agent.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(agent.title).toBe('Agent: Codex reviewer. Change Agent');
    expect(agentHandoffTriggerRef.current).toBe(agent);
    expect(agent.getAttribute('aria-haspopup')).toBe('dialog');
    expect(
      screen.getByRole('button', { name: /^Model:/ }).textContent,
    ).not.toContain('Model');
    expect(
      screen.getByRole('button', { name: /^Model:/ }).getAttribute('title'),
    ).toMatch(/^Model:/);
    agent.focus();
    // Browsers synthesize an untrusted click for keyboard activation of a
    // native button; detail=0 distinguishes that path from pointer input.
    fireEvent.click(agent, { detail: 0 });
    expect(onOpenAgentHandoff).toHaveBeenCalledOnce();
  });

  test('names an unavailable Agent change with its existing handoff reason', () => {
    renderChatInputArea({
      agentLabel: 'Codex reviewer',
      onOpenAgentHandoff: vi.fn(),
      agentHandoffDisabled: true,
      agentHandoffDisabledReason: 'Wait for the current turn to finish.',
    });

    const agent = screen.getByRole('button', {
      name: 'Agent: Codex reviewer. Wait for the current turn to finish.',
    }) as HTMLButtonElement;
    expect(agent.getAttribute('aria-disabled')).toBe('true');
    agent.focus();
    expect(document.activeElement).toBe(agent);
    expect(agent.title).toBe(
      'Agent: Codex reviewer. Wait for the current turn to finish.',
    );
    fireEvent.click(agent);
    expect(document.activeElement).toBe(agent);
  });

  test('opens offline with no cached catalog and explains that models are unavailable', async () => {
    function OfflineComposer() {
      const [modelQuery, setModelQuery] = useState<string | null>(null);
      return (
        <ChatInputArea
          {...renderProps({
            availableModels: [],
            canModelSelect: true,
            // Offline-no-cache: nothing has been confirmed live this
            // session, so the viewmodel derives unconfirmed/stale — the
            // discriminator between "unreachable" and "engine reported
            // no selectable models" (a REACHABLE engine's honest zero).
            modelsStale: true,
            modelQuery,
            onModelOpen: () => setModelQuery(''),
          })}
        />
      );
    }

    render(<OfflineComposer />);
    fireEvent.click(screen.getByRole('button', { name: /^Model/ }));

    expect(await screen.findByRole('dialog', { name: 'Model' })).toBeTruthy();
    expect(
      screen.getByText('Models unavailable while this Station is unreachable'),
    ).toBeTruthy();
  });

  test('marks hydrated last-known models stale while keeping them selectable', async () => {
    const onModelSelect = vi.fn();
    renderChatInputArea({
      modelQuery: '',
      modelsStale: true,
      onModelSelect,
    });
    await vi.dynamicImportSettled();

    expect(
      await screen.findByText('Model data could not be refreshed', undefined, {
        timeout: 5_000,
      }),
    ).toBeTruthy();
    expect(
      screen.getByText('Existing models, if shown, may be out of date.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /Claude Sonnet/ }));
    expect(onModelSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'claude-sonnet' }),
    );
  }, 7_500);

  test('renders the direct picker without replacing the draft with /model', async () => {
    renderChatInputArea({
      modelQuery: '',
      input: 'keep this draft',
      agentConnectionId: 'claude',
      modelRuntimeOptions: { effort: 'high' },
      availableModels: [
        {
          id: 'claude-sonnet',
          name: 'Claude Sonnet',
          capabilities: {
            supportsEffort: true,
            supportedEffortLevels: ['low', 'medium', 'high'],
          },
        },
      ],
    });

    expect(
      await screen.findByRole('dialog', { name: 'Choose model' }),
    ).toBeTruthy();
    expect(
      (screen.getByPlaceholderText(/Type a message/) as HTMLTextAreaElement)
        .value,
    ).toBe('keep this draft');
    expect(
      screen.getByRole('combobox', { name: 'Thinking effort' }),
    ).toBeTruthy();
  });

  test('#1291 anchors the model popover from the start (left) edge, matching its left-edge trigger', () => {
    renderChatInputArea({ modelQuery: '' });

    // The model chip sits at the left edge of the composer meta rail, like
    // ComposerActionsMenu and ComposerModeSheet — it must anchor with
    // `--start`, not `--end`, or the clamp saturates and pins the panel to
    // the far left of the viewport (archive#1291).
    const overlay = screen
      .getByRole('dialog', { name: 'Model' })
      .closest('.responsive-surface-overlay');
    expect(overlay?.className).toContain('composer-popover-overlay--start');
    expect(overlay?.className).not.toContain('composer-popover-overlay--end');
  });

  test('the accessible name carries the active model + connection, not just the control role', () => {
    renderChatInputArea({
      modelProviderLabel: 'OpenCode',
      agentDefaultModel: 'opencode/big-pickle',
      availableModels: [{ id: 'opencode/big-pickle', name: 'Big Pickle' }],
    });

    // Assistive tech reaching this control by role must be able to tell
    // which model/connection is active from the accessible name alone
    // (docs/design/chat-composer.md §3.3) — the visible identity spans are
    // aria-hidden, so the name has to carry the selection itself.
    const modelButton = screen.getByRole('button', {
      name: /OpenCode.*Big Pickle/,
    });
    expect(modelButton.getAttribute('aria-label')).toContain('OpenCode');
    expect(modelButton.getAttribute('aria-label')).toContain('Big Pickle');
    expect(modelButton.title).toContain('OpenCode');
    expect(modelButton.textContent).toBe('Big Pickle');
    // The source moved from a second visible line into the accessible name:
    // that subline is what made this pill two rows tall on a phone, and the
    // override state stays visible via the pill's own variant class.
    expect(modelButton.getAttribute('aria-label')).toContain('agent default');
  });

  test('offers the model and effort picker without exposing unknown telemetry or "runtime" vocabulary', () => {
    renderChatInputArea({
      agentDefaultModel: undefined,
      availableModels: [],
      currentModel: undefined,
    });

    const modelButton = screen.getByRole('button', { name: /^Model/ });
    expect(modelButton.textContent).toContain('Model & effort');
    expect(modelButton.getAttribute('aria-label')).toContain('Model & effort');
    expect(screen.queryByText('Model not reported')).toBeNull();
    expect(screen.queryByText('unknown')).toBeNull();
    expect(screen.queryByText('Default Model')).toBeNull();
  });

  test('replaces the "runtime" source with glossary vocabulary', () => {
    renderChatInputArea({
      currentModel: 'opencode/big-pickle',
      currentModelSource: 'runtime',
      availableModels: [{ id: 'opencode/big-pickle', name: 'Big Pickle' }],
    });

    // The source is exposed through the accessible name now rather than a
    // second visible line, but it still goes through modelSourceLabel — so
    // this remains a real guard against the internal "runtime" vocabulary
    // leaking to users (docs/design/chat-composer.md §2).
    const modelButton = screen.getByRole('button', { name: /^Model/ });
    const accessibleName = modelButton.getAttribute('aria-label') ?? '';
    expect(modelButton.textContent).not.toContain('runtime');
    expect(accessibleName).not.toContain('runtime');
    expect(accessibleName).toContain('reported by app');
  });

  test('offers a session-only reset when an override is active', () => {
    const onModelReset = vi.fn();
    renderChatInputArea({
      currentModel: 'override-model',
      currentModelSource: 'session override',
      onModelReset,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Use default' }));
    expect(onModelReset).toHaveBeenCalledOnce();
  });

  test('adds a pasted screenshot without changing the typed draft', async () => {
    const selectAttachmentFiles = vi.fn(async () => {});
    const onInputChange = vi.fn();
    renderChatInputArea({ selectAttachmentFiles, onInputChange });
    const textarea = screen.getByRole('textbox');

    fireEvent.paste(textarea, {
      clipboardData: {
        files: [new File(['abc'], 'screen.png', { type: 'image/png' })],
      },
    });

    await waitFor(() => expect(selectAttachmentFiles).toHaveBeenCalledOnce());
    expect(selectAttachmentFiles).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'screen.png' }),
    ]);
    expect(onInputChange).not.toHaveBeenCalled();
  });

  test('leaves file drop to the full chat pane owner', () => {
    const selectAttachmentFiles = vi.fn(async () => {});
    renderChatInputArea({ selectAttachmentFiles });
    const composer = screen.getByRole('group', {
      name: 'Message composer',
    });

    const notPrevented = fireEvent.drop(composer, {
      dataTransfer: {
        files: [new File(['abc'], 'dropped.png', { type: 'image/png' })],
      },
    });

    expect(notPrevented).toBe(true);
    expect(selectAttachmentFiles).not.toHaveBeenCalled();
  });

  test('clear input is an explicit non-submit button and preserves its action', () => {
    const onClearInput = vi.fn();
    renderChatInputArea({ onClearInput });
    const clear = screen.getByRole('button', { name: 'Clear input' });

    expect(clear.getAttribute('type')).toBe('button');
    fireEvent.click(clear);
    expect(onClearInput).toHaveBeenCalledOnce();
  });

  test('adds a pasted image exposed only through clipboardData.items (getAsFile path)', async () => {
    const selectAttachmentFiles = vi.fn(async () => {});
    const onInputChange = vi.fn();
    renderChatInputArea({ selectAttachmentFiles, onInputChange });
    const textarea = screen.getByRole('textbox');

    const image = new File(['abc'], 'pasted.png', { type: 'image/png' });
    // Safari / native webviews expose a pasted screenshot only on `items`
    // (kind: 'file' + getAsFile), leaving `files` empty. Copying an image from
    // a web page also carries an accompanying kind: 'string' text entry that
    // must not leak into the textarea.
    const notPrevented = fireEvent.paste(textarea, {
      clipboardData: {
        items: [
          { kind: 'string', type: 'text/plain', getAsFile: () => null },
          { kind: 'file', type: 'image/png', getAsFile: () => image },
        ],
        files: [],
      },
    });

    // fireEvent returns false when a handler called preventDefault.
    expect(notPrevented).toBe(false);
    await waitFor(() => expect(selectAttachmentFiles).toHaveBeenCalledOnce());
    expect(selectAttachmentFiles).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'pasted.png' }),
    ]);
    expect(onInputChange).not.toHaveBeenCalled();
  });

  // archive#3344.
  test('a pasted image is visible in the composer, with a remove affordance', async () => {
    const onRemoveAttachment = vi.fn();
    renderChatInputArea({
      onRemoveAttachment,
      attachments: [
        {
          id: 'att-1',
          name: 'screen.png',
          type: 'image/png',
          size: 3,
          data: 'data:image/png;base64,YWJj',
          preview: 'data:image/png;base64,YWJj',
        },
      ],
    });

    // The paperclip popover is mocked out in this file, so anything found
    // here is the composer's own strip, not the menu behind a click.
    const strip = screen.getByRole('list', { name: 'Attached files' });
    const thumbnail = within(strip).getByRole('img', { name: 'screen.png' });
    expect(thumbnail.getAttribute('src')).toBe('data:image/png;base64,YWJj');

    fireEvent.click(
      within(strip).getByRole('button', { name: 'Remove screen.png' }),
    );
    expect(onRemoveAttachment).toHaveBeenCalledWith('att-1');
  });

  // a single-attachment fixture cannot tell "removes the one
  // I clicked" from "removes whatever is first". Two attachments, and the
  // second one's button, is what gives the assertion power.
  test('removing one chip removes that attachment, not its neighbour', () => {
    const onRemoveAttachment = vi.fn();
    renderChatInputArea({
      onRemoveAttachment,
      attachments: [
        {
          id: 'att-first',
          name: 'first.png',
          type: 'image/png',
          size: 3,
          data: 'data:image/png;base64,YWJj',
          preview: 'data:image/png;base64,YWJj',
        },
        {
          id: 'att-second',
          name: 'second.png',
          type: 'image/png',
          size: 3,
          data: 'data:image/png;base64,ZGVm',
          preview: 'data:image/png;base64,ZGVm',
        },
      ],
    });

    const strip = screen.getByRole('list', { name: 'Attached files' });
    expect(within(strip).getAllByRole('listitem')).toHaveLength(2);

    fireEvent.click(
      within(strip).getByRole('button', { name: 'Remove second.png' }),
    );
    expect(onRemoveAttachment).toHaveBeenCalledTimes(1);
    expect(onRemoveAttachment).toHaveBeenCalledWith('att-second');
  });

  test('nothing is rendered for the strip when there are no attachments', () => {
    renderChatInputArea({ attachments: [] });
    expect(screen.queryByRole('list', { name: 'Attached files' })).toBeNull();
  });

  test('an engine that cannot see images refuses the paste in its own words', async () => {
    const selectAttachmentFiles = vi.fn(async () => {});
    renderChatInputArea({
      selectAttachmentFiles,
      modelSupportsAttachments: false,
      fileAttachmentsSupported: false,
      attachmentError:
        'Muse Code runs a text-only prompt and cannot see images.',
    });
    const textarea = screen.getByRole('textbox');

    fireEvent.paste(textarea, {
      clipboardData: {
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () =>
              new File(['abc'], 'screen.png', { type: 'image/png' }),
          },
        ],
        files: [],
      },
    });

    expect(
      screen.getByText(
        'Muse Code runs a text-only prompt and cannot see images.',
      ),
    ).toBeTruthy();
    await waitFor(() => expect(selectAttachmentFiles).toHaveBeenCalledOnce());
    expect(screen.queryByRole('list', { name: 'Attached files' })).toBeNull();
  });

  test('does not intercept a plain-text paste', () => {
    const selectAttachmentFiles = vi.fn(async () => {});
    const onInputChange = vi.fn();
    renderChatInputArea({ selectAttachmentFiles, onInputChange });
    const textarea = screen.getByRole('textbox');

    const notPrevented = fireEvent.paste(textarea, {
      clipboardData: {
        items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
        files: [],
      },
    });

    // No file item present → default paste proceeds and the pipeline is idle.
    expect(notPrevented).toBe(true);
    expect(selectAttachmentFiles).not.toHaveBeenCalled();
    expect(onInputChange).not.toHaveBeenCalled();
  });

  test('#727 review round 3, item 2 (MEDIUM): a session switch resets the approval-mode chip pending confirm state instead of leaking it onto the new session', async () => {
    const onApprovalModeChange = vi.fn();
    const { rerender } = render(
      <ChatInputArea
        {...renderProps({
          sessionId: 'session-a',
          executionMode: 'external',
          agentConnectionId: 'codex',
          modelRuntimeOptions: { approvalMode: 'ask' },
          onApprovalModeChange,
        })}
      />,
    );

    // Start an escalation on session A — opens the mode sheet and picks full
    // access, which must land on the confirm step rather than applying.
    fireEvent.click(screen.getByRole('button', { name: /^Approval mode:/ }));
    // The mode sheet is lazy-loaded; wait for it rather than the Suspense null.
    await screen.findByRole('radiogroup', { name: 'Approval mode' });
    fireEvent.click(
      screen.getByRole('radio', { name: /Never ask \(full access\)/ }),
    );
    expect(
      screen.getByRole('button', { name: 'Enable full access' }),
    ).toBeTruthy();
    expect(onApprovalModeChange).not.toHaveBeenCalled();

    // The user switches to a different session before confirming.
    rerender(
      <ChatInputArea
        {...renderProps({
          sessionId: 'session-b',
          executionMode: 'external',
          agentConnectionId: 'codex',
          modelRuntimeOptions: { approvalMode: 'ask' },
          onApprovalModeChange,
        })}
      />,
    );

    // Session B must not inherit session A's pending confirm — the sheet (and
    // its confirm step) is gone, the chip is back to showing session B's own
    // state, and the escalation was never applied to either session.
    expect(
      screen.queryByRole('button', { name: 'Enable full access' }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /^Approval mode: Ask every time\./ }),
    ).toBeTruthy();
    expect(onApprovalModeChange).not.toHaveBeenCalled();
  });

  describe('prompt size guard (station#2807)', () => {
    test('reports the exact overage, disables send, and never clears the draft itself', () => {
      const onSend = vi.fn(async () => {});
      const onInputChange = vi.fn();
      const onClearInput = vi.fn();
      const overBy = 2431;
      renderChatInputArea({
        input: 'x'.repeat(CHAT_INPUT_MAX_CHARS + overBy),
        onSend,
        onInputChange,
        onClearInput,
      });

      // The guard itself touches nothing: the draft renders untruncated and
      // no spontaneous clear/rewrite fires on mount (a guard that auto-cleared
      // would call one of these).
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.value).toHaveLength(CHAT_INPUT_MAX_CHARS + overBy);
      expect(onInputChange).not.toHaveBeenCalled();
      expect(onClearInput).not.toHaveBeenCalled();

      // Exact, actionable overage — not a generic "too long".
      expect(screen.getByRole('alert').textContent).toContain(
        '2,431 characters over the limit',
      );

      // Send is disabled and Enter cannot send either.
      expect(
        (screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSend).not.toHaveBeenCalled();

      // The one path that can clear the draft stays the user's explicit ×
      // click — available while over-limit, and not hijacked by the guard.
      fireEvent.click(screen.getByRole('button', { name: 'Clear input' }));
      expect(onClearInput).toHaveBeenCalledOnce();
      expect(onInputChange).not.toHaveBeenCalled();
    });

    test('sends normally at exactly the shared limit constant', () => {
      // The composer's boundary derives from the same exported
      // CHAT_INPUT_MAX_CHARS the server bounds are pinned against (see the
      // chatSchema shape tests and
      // orchestration/__tests__/orchestration-chat-input-limits.test.ts —
      // the seam this composer actually posts to). A hardcoded composer
      // number goes red here or there.
      const onSend = vi.fn(async () => {});
      renderChatInputArea({
        input: 'x'.repeat(CHAT_INPUT_MAX_CHARS),
        onSend,
      });

      expect(screen.queryByRole('alert')).toBeNull();
      expect(
        (screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
      expect(onSend).toHaveBeenCalledTimes(1);
    });

    test('send re-enables once the draft is trimmed back under the limit', () => {
      const { rerender } = render(
        <ChatInputArea
          {...renderProps({ input: 'x'.repeat(CHAT_INPUT_MAX_CHARS + 1) })}
        />,
      );
      expect(
        (screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);

      rerender(
        <ChatInputArea
          {...renderProps({ input: 'x'.repeat(CHAT_INPUT_MAX_CHARS - 1) })}
        />,
      );
      expect(
        (screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});

function renderProps(overrides: Record<string, unknown> = {}) {
  return {
    agentSlug: 'station',
    conversationId: undefined,
    messageCount: 0,
    input: 'hello',
    attachments: [],
    textareaRef: { current: null },
    disabled: false,
    isSending: false,
    turnInFlight: false,
    modelSupportsAttachments: true,
    fontSize: 14,
    dockHeight: 600,
    apiBase: 'http://localhost:3242',
    currentModel: undefined,
    canModelSelect: true,
    agentDefaultModel: 'claude-sonnet',
    availableModels: [{ id: 'claude-sonnet', name: 'Claude Sonnet' }],
    modelQuery: null,
    commandQuery: null,
    slashCommands: [],
    onInputChange: vi.fn(),
    onSend: vi.fn(async () => {}),
    onCancel: vi.fn(),
    onClearInput: vi.fn(),
    selectAttachmentFiles: vi.fn(async () => {}),
    attachmentError: null,
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
    onShowStats: vi.fn(),
    updateFromInput: vi.fn(),
    closeAll: vi.fn(),
    ...overrides,
  } as React.ComponentProps<typeof ChatInputArea>;
}
