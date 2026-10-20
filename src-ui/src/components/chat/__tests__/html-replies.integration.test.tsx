/** @vitest-environment jsdom */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../../../src-server/__test-utils__/temp-dirs.js';
import { createHtmlReplyRoutes } from '../../../../../src-server/routes/orchestration/html-replies.js';
import { createHtmlReplyPages } from '../../../../../src-server/services/orchestration/html-reply-pages.js';
import { conversationPartToContentParts } from '../../../hooks/orchestration/conversationTranscriptParts';
import { MessageContent } from '../message-bubble/MessageContent';
import { StreamingMessageView } from '../StreamingMessage';

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://html-reply.test' }),
  useHostRequestAuthorityScope: () => undefined,
}));
vi.mock('../../../contexts/DeviceSettingsContext', () => ({
  useDeviceSettings: () => ({ theme: 'dark' }),
}));
vi.mock('../ToolCallDisplay', () => ({
  ToolCallDisplay: () => <div>Published page tool</div>,
}));

const makeTempDir = trackTempDirs();
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test.each([
  'mcp__station-control__html_render',
  'Tool: station-control/html_render',
])(
  'render route stores immutable bytes and the transcript mounts the qualified ACP result %s with current read authorization',
  async (toolName) => {
    const root = makeTempDir('html-reply-integration-');
    const file = join(root, 'events.sqlite');
    let db = new DatabaseSync(file);
    let pages = createHtmlReplyPages(
      db,
      (sessionId) => sessionId === 'session-a',
    );
    const app = new Hono();
    const caller = {
      sessionId: 'session-a',
      conversationId: 'conversation-a',
      assurance: 'bound' as const,
    };
    app.route(
      '/api/html-replies',
      createHtmlReplyRoutes({
        pages: pages,
        frameOrigin: () => 'http://sandbox.test',
        isInternalRequest: () => true,
        resolveCaller: () => caller,
        sessionContext: () => ({ cwd: root, conversationId: 'conversation-a' }),
        canReadSession: (sessionId) => sessionId === 'session-a',
        preview: async () => {
          throw new Error('Preview not requested');
        },
      }),
    );
    vi.stubGlobal(
      'fetch',
      (input: string | URL | Request, init?: RequestInit) =>
        app.request(
          input instanceof Request ? input : new Request(input, init),
        ),
    );
    vi.stubEnv('STATION_API_BASE', 'http://html-reply.test');
    try {
      const response = await app.request('/api/html-replies/render', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          html: '<h1>Retained visual reply</h1>',
          height: 420,
        }),
      });
      expect(response.status).toBe(200);
      const result = {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(await response.json()),
          },
        ],
      };
      const text = result.content.find((part) => part.type === 'text');
      if (text?.type !== 'text') throw new Error('No tool reference');
      const { htmlReply: reference } = JSON.parse(text.text);
      expect(reference.sessionId).toBe('session-a');
      expect(text.text).not.toContain('<h1>');
      db.close();
      db = new DatabaseSync(file);
      pages = createHtmlReplyPages(
        db,
        (sessionId) => sessionId === 'session-a',
      );
      expect(pages.read(reference)?.html).toBe(
        '<h1>Retained visual reply</h1>',
      );
      // The route must read the reopened canonical store, not an in-memory result.
      const readApp = new Hono().route(
        '/api/html-replies',
        createHtmlReplyRoutes({
          pages: pages,
          frameOrigin: () => 'http://sandbox.test',
          isInternalRequest: () => false,
          resolveCaller: () => null,
          sessionContext: () => undefined,
          canReadSession: (sessionId) => sessionId === 'session-a',
          preview: async () => {
            throw new Error('Not requested');
          },
        }),
      );
      vi.stubGlobal(
        'fetch',
        (input: string | URL | Request, init?: RequestInit) =>
          readApp.request(
            input instanceof Request ? input : new Request(input, init),
          ),
      );
      const rows = projectRuntimeEventsToMessages(
        [
          {
            eventId: 'published',
            provider: 'acp',
            threadId: 'session-a',
            method: 'tool.completed',
            turnId: 'turn-a',
            itemId: 'item-a',
            toolCallId: 'call-a',
            toolName,
            status: 'success',
            output: JSON.stringify(result).slice(0, 84),
            htmlReply: reference,
            createdAt: new Date().toISOString(),
          },
        ],
        { stableIds: true },
      );
      const row = rows.find((row) => row.role === 'assistant');
      if (!row)
        throw new Error('Published tool did not project to an assistant row');
      const query = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const view = render(
        <QueryClientProvider client={query}>
          <MessageContent
            contentParts={row.parts.flatMap(conversationPartToContentParts)}
            textContent=""
            chatFontSize={14}
            showReasoning={false}
            showToolDetails={false}
            isStreamingMessage={false}
            foldWork
          />
        </QueryClientProvider>,
      );
      await waitFor(() =>
        expect(screen.queryByTitle('Visual reply')).toBeInstanceOf(
          HTMLIFrameElement,
        ),
      );
      const iframe = screen.getByTitle('Visual reply');
      if (!(iframe instanceof HTMLIFrameElement))
        throw new Error('Missing visual reply frame');
      const post = vi.spyOn(
        (iframe as HTMLIFrameElement).contentWindow!,
        'postMessage',
      );
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            source: (iframe as HTMLIFrameElement).contentWindow,
            origin: 'http://sandbox.test',
            data: { type: 'html-reply-ready' },
          }),
        );
      });
      await waitFor(() =>
        expect(post).toHaveBeenCalledWith(
          { type: 'html-reply-load', html: '<h1>Retained visual reply</h1>' },
          'http://sandbox.test',
        ),
      );
      expect(
        view.container.textContent?.indexOf('Published page tool'),
      ).toBeGreaterThanOrEqual(0);
      expect(
        (
          await readApp.request(
            `/api/html-replies/other-session/${reference.pageId}`,
          )
        ).status,
      ).toBe(404);
      pages.deleteThread('session-a');
      expect(pages.read(reference)).toBeUndefined();
      expect(
        (
          await readApp.request(
            `/api/html-replies/session-a/${reference.pageId}`,
          )
        ).status,
      ).toBe(404);
      view.unmount();
      // The live renderer receives completed tool parts while the turn continues.
      const liveParts = row.parts.flatMap(conversationPartToContentParts);
      const live = render(
        <QueryClientProvider client={query}>
          <StreamingMessageView
            sessionId="session-a"
            agentIcon={null}
            agentIconStyle={{}}
            fontSize={14}
            streamingText=""
            hasContent
            contentParts={[]}
            contentRevision={0}
            suppressActivity
          />
        </QueryClientProvider>,
      );
      expect(screen.queryByTitle('Visual reply')).toBeNull();
      // Restore bytes for the distinct streaming mount assertion.
      const liveRef = pages.publish('session-a', 'conversation-a', {
        version: 1,
        html: '<h1>Live page</h1>',
        height: 400,
      });
      live.rerender(
        <QueryClientProvider client={query}>
          <StreamingMessageView
            sessionId="session-a"
            agentIcon={null}
            agentIconStyle={{}}
            fontSize={14}
            streamingText=""
            hasContent
            contentRevision={1}
            suppressActivity
            contentParts={liveParts.map((part) => ({
              ...part,
              htmlReply: liveRef,
            }))}
          />
        </QueryClientProvider>,
      );
      await waitFor(() =>
        expect(screen.queryByTitle('Visual reply')).toBeInstanceOf(
          HTMLIFrameElement,
        ),
      );
      query.clear();
    } finally {
      db.close();
    }
  },
);
