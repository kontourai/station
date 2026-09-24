/**
 * @vitest-environment jsdom
 *
 * An image a tool returned (a screenshot the agent took) renders as a
 * clickable preview on the streaming row AND on the settled row it becomes,
 * from the blob reference alone: the bytes come through the authenticated
 * attachment route, which is what lets a phone or a remote browser see it.
 * Clicking opens the image lightbox with the fetched image.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ChatContentPart } from '../contexts/active-chats-state';

const REF = `sha256-${'b'.repeat(64)}`;
const TOOL_PARTS: ChatContentPart[] = [
  {
    type: 'tool-invocation',
    toolCallId: 'call-1',
    toolName: 'mcp__browser__screenshot',
    state: 'completed',
    sourceEventId: 'tool-done',
    result: 'Captured the page.',
  },
  {
    type: 'file',
    blobRef: REF,
    mediaType: 'image/png',
    name: 'image-1.png',
    toolCallId: 'call-1',
    sourceEventId: 'tool-done',
  },
];

const { authenticatedFetch, openPreview } = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  openPreview: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  authenticatedFetch,
}));
vi.mock('../contexts/PreviewContext', () => ({
  usePreview: () => ({ openPreview }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [{ slug: 'dev-agent', name: 'Dev Agent' }],
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('../hooks/useToolApproval', () => ({
  useToolApproval: () => vi.fn(),
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => vi.fn(),
}));
vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => <span aria-hidden="true">U</span>,
}));
vi.mock('../hooks/useStreamingContent', () => ({
  useStreamingContent: () => ({
    streamingText: '',
    hasContent: true,
    contentParts: TOOL_PARTS,
    contentRevision: 1,
  }),
}));

import { resetAttachmentObjectUrls } from '../components/chat/attachment-object-urls';
import { ChatMessageList } from '../components/chat/ChatMessageList';

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

const baseSession = {
  agentSlug: agentId('dev-agent'),
  agentName: 'Dev Agent',
  input: '',
  attachments: [],
  queuedMessages: [],
  inputHistory: [],
  hasUnread: false,
  createdAt: 1,
  updatedAt: 1,
  source: 'manual' as const,
};

beforeEach(() => {
  Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:tool-screenshot'),
    revokeObjectURL: vi.fn(),
  });
  authenticatedFetch.mockReset();
  authenticatedFetch.mockImplementation(
    async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
  );
  openPreview.mockReset();
});

afterEach(() => {
  resetAttachmentObjectUrls();
});

describe('a tool-returned image renders on the streaming and the settled row', () => {
  test.each([
    [
      'streaming',
      { id: 'tool-image-streaming', status: 'sending' as const, messages: [] },
    ],
    [
      'settled',
      {
        id: 'tool-image-settled',
        status: 'idle' as const,
        messages: [
          {
            role: 'assistant' as const,
            content: '',
            contentParts: TOOL_PARTS,
            timestamp: 1,
          },
        ],
      },
    ],
  ])(
    '%s row: fetched by reference and opens the lightbox',
    async (_label, session) => {
      const { container } = renderWithQueryClient(
        <ChatMessageList
          activeSession={{ ...baseSession, title: 'Screenshot', ...session }}
          fontSize={14}
          showReasoning
          showToolDetails
        />,
      );

      const preview = await waitFor(() =>
        within(container).getByRole('button', { name: 'Preview image-1.png' }),
      );
      expect(authenticatedFetch).toHaveBeenCalledWith(
        `http://station.test/api/attachments/${REF}`,
      );
      expect(
        within(preview).getByAltText('image-1.png').getAttribute('src'),
      ).toBe('blob:tool-screenshot');

      fireEvent.click(preview);
      expect(openPreview).toHaveBeenCalledWith(
        {
          url: 'blob:tool-screenshot',
          mediaType: 'image/png',
          name: 'image-1.png',
        },
        expect.any(Array),
      );
    },
  );
});
