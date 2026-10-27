// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../contexts/ApiBaseContext')>()),
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../contexts/PreviewContext', () => ({
  usePreview: () => ({ openPreview: vi.fn() }),
}));

import {
  attachmentObjectUrlKey,
  attachmentThumbnailKey,
  peekAttachmentObjectUrl,
  resetAttachmentObjectUrls,
  storeAttachmentObjectUrl,
} from '../components/chat/attachment-object-urls';
import { FilePartPreview } from '../components/chat/FilePartPreview';
import { activeChatsStore } from '../contexts/active-chats-store';
import { handleTurnStartedEvent } from '../hooks/orchestration/turnHandlers';
import { buildOutgoingUserMessage } from '../hooks/useActiveChatSessions.helpers';

const chat = 'large-picture-chat';
const REF = `sha256-${'f'.repeat(64)}`;
// 300,000 decoded bytes: past the 256 KB line where a chip shows a thumbnail
// rather than decoding the full picture.
const LARGE_PNG = `data:image/png;base64,${'A'.repeat(400_000)}`;
let minted = 0;

beforeEach(() => {
  minted = 0;
  Object.assign(URL, {
    createObjectURL: () => `blob:minted-${++minted}`,
    revokeObjectURL: vi.fn(),
  });
  activeChatsStore.initChat(chat, {
    agentSlug: 'codex',
    agentName: 'Codex',
    title: 'Large picture',
  });
});
afterEach(() => {
  activeChatsStore.removeChat(chat);
  resetAttachmentObjectUrls();
});

const filePart = () =>
  activeChatsStore
    .getSnapshot()
    [chat].messages?.[0].contentParts?.find((part) => part.type === 'file')!;

test('a large sent picture keeps its thumbnail through turn.started, and no cache entry stays keyed by its data URL', () => {
  const { messages } = buildOutgoingUserMessage(
    [],
    'See this',
    [
      {
        id: 'large',
        name: 'large.png',
        type: 'image/png',
        size: 300_000,
        data: LARGE_PNG,
        preview: LARGE_PNG,
      },
    ],
    'send-large',
  );
  activeChatsStore.updateChat(chat, {
    pendingClientTurnId: 'send-large',
    messages,
  });
  // The thumbnail the live chip made from its inline bytes (jsdom cannot
  // decode, so it is placed where the chip's own effect stores it).
  storeAttachmentObjectUrl(
    attachmentThumbnailKey(LARGE_PNG),
    'blob:thumbnail',
    new Blob([new Uint8Array(10)], { type: 'image/png' }),
    { width: 80, height: 80 },
  );
  const view = render(<FilePartPreview part={filePart()} />);
  expect(screen.getByAltText('large.png').getAttribute('src')).toBe(
    'blob:thumbnail',
  );

  handleTurnStartedEvent({
    eventId: 'large-started',
    method: 'turn.started',
    provider: 'codex',
    threadId: chat,
    turnId: 'large-turn',
    createdAt: '2026-09-12T00:00:00Z',
    prompt: 'See this',
    clientTurnId: 'send-large',
    attachments: [
      {
        kind: 'image',
        name: 'large.png',
        mimeType: 'image/png',
        size: 300_000,
        blobRef: REF,
      },
    ],
  });
  const switched = filePart();
  expect(switched).toEqual({
    type: 'file',
    blobRef: REF,
    mediaType: 'image/png',
    name: 'large.png',
  });

  // The switched chip's FIRST render (server markup runs no effects) is
  // already the thumbnail, not the 'pending' icon.
  const firstRender = renderToStaticMarkup(<FilePartPreview part={switched} />);
  expect(firstRender).toContain('aria-label="Preview large.png"');
  expect(firstRender).toContain('src="blob:thumbnail"');
  expect(firstRender).not.toContain('file-part-preview__icon');

  view.rerender(<FilePartPreview part={switched} />);
  expect(screen.getByAltText('large.png').getAttribute('src')).toBe(
    'blob:thumbnail',
  );
  // Nothing in the cache is keyed by the multi-megabyte data URL any more.
  expect(
    peekAttachmentObjectUrl(attachmentThumbnailKey(LARGE_PNG)),
  ).toBeUndefined();
  const refKey = attachmentObjectUrlKey(REF, 'image/png');
  expect(peekAttachmentObjectUrl(attachmentThumbnailKey(refKey))).toBe(
    'blob:thumbnail',
  );
  expect(peekAttachmentObjectUrl(refKey)).toBe('blob:minted-1');
});
