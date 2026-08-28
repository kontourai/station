/**
 * @vitest-environment jsdom
 *
 * archive#1825: the model popover's `React.lazy(SessionModelPicker)`
 * Suspense fallback ("Loading models…") rendered as bare text with no
 * surface behind it — floating over the page, reading as broken rather than
 * "about to load" — because `.session-model-picker__loading` had no CSS
 * declared anywhere, and the popover panel it sits inside deliberately
 * carries no chrome of its own (the "single opt-out" documented above
 * `.composer-popover-panel.chat-input__model-popover-panel` in chat.css:
 * `SessionModelPicker` supplies its own border/radius/shadow once it
 * mounts). This only ever shows on the *first* open of a fresh page load,
 * before the lazy chunk has resolved — exactly the render this test
 * captures by never having imported `SessionModelPicker` before this
 * render.
 *
 * Vitest's jsdom environment performs no real CSS layout (this repo leaves
 * `test.css` at its default `false`), so this test pins the two things that
 * jointly determine whether the fallback reads as a real surface: the class
 * name applied to the fallback element, and the CSS declarations of that
 * class in the stylesheet it must live in to be present on first paint (see
 * the `responsive-dialog-header.test.tsx` sibling suite for the same
 * eager/lazy-chunk defect class, archive#1825).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
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

// Deliberately NOT mocking '../session/SessionModelPicker' — the whole point
// is to observe the real `React.lazy` Suspense boundary on its first,
// unresolved render.

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

const SRC_UI_ROOT = path.resolve(__dirname, '..');
function readSource(relativePath: string): string {
  return readFileSync(path.join(SRC_UI_ROOT, relativePath), 'utf8');
}

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
    onAddAttachments: vi.fn(),
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

describe('model popover Suspense fallback (station#1825 item 2)', () => {
  test('uses the eager skeleton only while an empty catalog is genuinely loading', () => {
    renderChatInputArea({
      availableModels: [],
      modelsLoading: true,
      modelQuery: '',
    });
    expect(screen.getByLabelText('Loading models')).toBeTruthy();
  });

  test('uses the eager unavailable state for a settled empty offline catalog', () => {
    renderChatInputArea({
      availableModels: [],
      modelsLoading: false,
      modelsStale: true,
      modelQuery: '',
    });
    expect(
      screen.getByText('Models unavailable while this Station is unreachable'),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Loading models')).toBeNull();
  });

  test('the first-open loading state renders with its own surface, not bare text over the page', () => {
    renderChatInputArea({ modelQuery: '' });

    // This must be observable on the very FIRST, synchronous render — before
    // the lazy chunk's promise has had a chance to resolve — or the test
    // proves nothing about the first-open defect.
    // The wait now renders the shared row skeleton and names itself in the
    // accessible label ('s one loading vocabulary) rather than as
    // bespoke visible copy — but it keeps this wrapper class, because the
    // wrapper is what carries the surface this test exists to protect.
    const loading = screen.getByLabelText('Loading models');
    expect(loading.className).toContain('skeleton-list');
    expect(loading.closest('.session-model-picker__loading')).toBeTruthy();

    const indexCss = readSource('index.css');
    const rule = indexCss.match(
      /\.session-model-picker__loading\s*\{([^}]*)\}/,
    );
    expect(
      rule,
      '.session-model-picker__loading should be defined in the eagerly loaded index.css',
    ).toBeTruthy();
    const body = rule![1];
    // A real surface, not just muted text: a border/background/shadow that
    // matches what SessionModelPicker itself looks like once it mounts.
    expect(body).toMatch(/border:/);
    expect(body).toMatch(/background:/);
    expect(body).toMatch(/box-shadow:/);

    // The actual pre-fix defect: this class must not be (re-)defined in the
    // lazy SessionModelPicker.css chunk — that stylesheet has not loaded yet
    // during exactly this render, so any styling placed there is invisible
    // the one time it matters.
    const lazyCss = readSource('components/session/SessionModelPicker.css');
    expect(lazyCss).not.toMatch(/\.session-model-picker__loading\s*\{/);
  });
});
