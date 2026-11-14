// @vitest-environment jsdom
/**
 * Paste image: one reader (`readClipboardImageFiles`) feeds each composer's
 * own select path. The composer cases run the real default sources: under
 * jsdom the web adapter reports `clipboard-image` unsupported, so the read
 * falls through to `navigator.clipboard.read()`, which these tests provide.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ChatInputArea } from '../components/chat/ChatInputArea';
import { StartComposer } from '../components/chat-start/StartComposer';
import { RoomComposer } from '../components/room/RoomComposer';
import {
  type ClipboardImageSources,
  NO_CLIPBOARD_IMAGE_MESSAGE,
  readClipboardImageFiles,
} from '../hooks/useClipboardImagePaste';
import type {
  NativeCapabilityState,
  NativeCommandResult,
  NativeImageList,
} from '../platform/native/types';

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
vi.mock('../components/voice/VoiceOrb', () => ({ VoiceOrb: () => null }));

const PNG_BYTES: Uint8Array<ArrayBuffer> = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_DATA_URL = `data:image/png;base64,${btoa(String.fromCharCode(...PNG_BYTES))}`;

function clipboardItem(
  type: string,
  bytes: Uint8Array<ArrayBuffer> = PNG_BYTES,
) {
  return {
    types: [type],
    getType: vi.fn(async () => new Blob([bytes], { type })),
  };
}

function setCoarsePointer(coarse: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: coarse && query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function setClipboard(read: (() => Promise<unknown>) | undefined) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: read ? { read } : undefined,
  });
}

beforeEach(() => {
  setCoarsePointer(true);
  setClipboard(async () => [clipboardItem('image/png')]);
});

afterEach(() => {
  cleanup();
  setClipboard(undefined);
});

function nativeSources(
  state: NativeCapabilityState,
  result: NativeCommandResult<NativeImageList>,
  browserRead?: () => Promise<unknown>,
) {
  const readClipboardImages = vi.fn(async () => result);
  const sources: ClipboardImageSources = {
    native: async () => ({
      capability: (id) => ({ id, state, reason: 'fixture' }),
      readClipboardImages,
    }),
    clipboard: () =>
      browserRead
        ? ({ read: browserRead } as unknown as Pick<Clipboard, 'read'>)
        : undefined,
  };
  return { sources, readClipboardImages };
}

describe('readClipboardImageFiles', () => {
  test('a native host that reports clipboard-image reads through the plugin', async () => {
    const browserRead = vi.fn();
    const { sources, readClipboardImages } = nativeSources(
      'enabled',
      {
        status: 'ok',
        value: {
          files: [
            { name: 'shot.png', mimeType: 'image/png', dataUrl: PNG_DATA_URL },
          ],
        },
      },
      browserRead,
    );
    const result = await readClipboardImageFiles(sources);
    expect(readClipboardImages).toHaveBeenCalledOnce();
    expect(browserRead).not.toHaveBeenCalled();
    if (result.status !== 'ok') throw new Error(`got ${result.status}`);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).toBe('shot.png');
    expect(result.files[0].type).toBe('image/png');
    expect(new Uint8Array(await result.files[0].arrayBuffer())).toEqual(
      PNG_BYTES,
    );
  });

  test('a native read with no image is empty, and a refusal keeps its words', async () => {
    expect(
      await readClipboardImageFiles(
        nativeSources('enabled', { status: 'ok', value: { files: [] } })
          .sources,
      ),
    ).toEqual({ status: 'empty' });
    expect(
      await readClipboardImageFiles(
        nativeSources('enabled', {
          status: 'error',
          command: 'read-clipboard-images',
          message: 'Station can take at most 5 images at once.',
        }).sources,
      ),
    ).toEqual({
      status: 'error',
      message: 'Station can take at most 5 images at once.',
    });
  });

  test('without the native capability the browser clipboard is read, admitted types only', async () => {
    const browserRead = vi.fn(async () => [
      { types: ['text/plain'], getType: vi.fn() },
      clipboardItem('image/webp'),
      clipboardItem('image/heic'),
    ]);
    const { sources, readClipboardImages } = nativeSources(
      'unsupported',
      { status: 'ok', value: { files: [] } },
      browserRead,
    );
    const result = await readClipboardImageFiles(sources);
    expect(readClipboardImages).not.toHaveBeenCalled();
    if (result.status !== 'ok') throw new Error(`got ${result.status}`);
    expect(result.files.map((file) => [file.name, file.type])).toEqual([
      ['pasted-image-1.webp', 'image/webp'],
    ]);
  });

  test('a denied browser read is an error, not an empty clipboard', async () => {
    const { sources } = nativeSources(
      'unsupported',
      { status: 'ok', value: { files: [] } },
      async () => {
        throw new DOMException('denied', 'NotAllowedError');
      },
    );
    expect(await readClipboardImageFiles(sources)).toEqual({
      status: 'error',
      message: 'Station could not read the clipboard.',
    });
  });
});

function renderChatInput(overrides: Record<string, unknown> = {}) {
  const props = {
    agentSlug: 'station',
    messageCount: 0,
    input: '',
    attachments: [],
    textareaRef: { current: null },
    disabled: false,
    turnInFlight: false,
    modelSupportsAttachments: true,
    fontSize: 14,
    dockHeight: 600,
    apiBase: 'http://localhost:3242',
    canModelSelect: false,
    availableModels: [],
    modelQuery: null,
    commandQuery: null,
    slashCommands: [],
    onInputChange: vi.fn(),
    onSend: vi.fn(async () => {}),
    onCancel: vi.fn(),
    onClearInput: vi.fn(),
    selectAttachmentFiles: vi.fn(async (_files: File[]) => {}),
    onAttachUnavailable: vi.fn(),
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
  render(
    <ChatInputArea
      {...(props as unknown as ComponentProps<typeof ChatInputArea>)}
    />,
  );
  return props;
}

function renderStart(onAdd = vi.fn()) {
  render(
    <StartComposer
      prompt=""
      onPromptChange={() => undefined}
      agent={{ status: 'ready', needsSetup: false }}
      onOpenAgents={() => undefined}
      project={{ status: 'ready', label: 'No project', isGlobal: true }}
      onOpenProject={() => undefined}
      canStart
      pending={false}
      onStart={() => undefined}
      files={{ list: [], onAdd, onRemove: vi.fn() }}
    />,
  );
  return onAdd;
}

function taskRoomAttachments() {
  return {
    files: [],
    busy: false,
    error: null,
    setError: vi.fn(),
    selectFiles: vi.fn(),
    remove: vi.fn(),
  };
}

/** The room composer (#4810) Task rooms and agent-thread replies use. */
function renderTaskRoom(
  attachments: ReturnType<
    typeof taskRoomAttachments
  > | null = taskRoomAttachments(),
) {
  render(
    <RoomComposer
      id="room-message"
      label="Message the task room"
      placeholder="Message"
      value=""
      onValueChange={() => {}}
      onSend={() => {}}
      canSend={false}
      sendLabel="Send to task room"
      {...(attachments
        ? { attachments: { port: attachments, locked: false, owner: 'task-1' } }
        : {})}
    />,
  );
  return attachments;
}

async function pasteButton() {
  return screen.findByRole('button', { name: 'Paste image' });
}

function expectOnePastedPng(files: File[]) {
  expect(files).toHaveLength(1);
  expect(files[0]).toBeInstanceOf(File);
  expect(files[0].type).toBe('image/png');
  expect(files[0].name).toBe('pasted-image-1.png');
}

describe('Paste image in each composer', () => {
  test('the reply and start composers no longer offer Paste image', async () => {
    // Keyboard and Ctrl/Cmd+V paste stay; the clipboard button is room-only.
    renderChatInput();
    renderStart();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('button', { name: 'Paste image' })).toBeNull();
  });

  test('the room composer pastes into its attachment port', async () => {
    const attachments = renderTaskRoom()!;
    fireEvent.click(await pasteButton());
    await waitFor(() => expect(attachments.selectFiles).toHaveBeenCalledOnce());
    expectOnePastedPng(attachments.selectFiles.mock.calls[0][0]);
  });

  test('a clipboard without an image says so through the room composer', async () => {
    setClipboard(async () => [{ types: ['text/plain'], getType: vi.fn() }]);

    const attachments = renderTaskRoom()!;
    fireEvent.click(await pasteButton());
    await waitFor(() =>
      expect(attachments.setError).toHaveBeenCalledWith(
        NO_CLIPBOARD_IMAGE_MESSAGE,
      ),
    );
    expect(attachments.selectFiles).not.toHaveBeenCalled();
  });

  test('is not offered to a fine pointer, which pastes into the field itself', async () => {
    setCoarsePointer(false);
    renderChatInput();
    renderStart();
    renderTaskRoom();
    // Let the native capability probe settle before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('button', { name: 'Paste image' })).toBeNull();
  });

  test('is not offered where the browser cannot read the clipboard', async () => {
    setClipboard(undefined);
    renderStart();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('button', { name: 'Paste image' })).toBeNull();
  });

  test('a room without an attachment port offers no Paste image', async () => {
    renderTaskRoom(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      screen.getByRole('textbox', { name: 'Message the task room' }),
    ).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Paste image' })).toBeNull();
  });
});
