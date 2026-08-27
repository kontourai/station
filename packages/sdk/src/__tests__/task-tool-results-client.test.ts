import { afterEach, expect, test, vi } from 'vitest';
import {
  attachTaskToolResultReference,
  getSessionToolResult,
  TaskToolResultRequestError,
} from '../client/task-tool-results.js';

afterEach(() => vi.unstubAllGlobals());

const result = {
  resultId: 'event-a',
  name: 'tool',
  terminalStatus: 'success',
  content: [{ type: 'text', text: 'inert' }],
  truncated: false,
  omittedParts: 0,
  omittedTextBytes: 0,
  omittedMetadataBytes: 0,
};

test('tool-result client accepts only the exact requested tuple and owner-safe projection', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { sessionId: 'session-a', eventId: 'event-a', result },
        }),
      ),
    ),
  );
  await expect(
    getSessionToolResult('http://station.test', 'session-a', 'event-a'),
  ).resolves.toEqual(result);
});

test.each([
  {
    success: true,
    data: { sessionId: 'session-a', eventId: 'event-b', result },
  },
  {
    success: true,
    data: {
      sessionId: 'session-a',
      eventId: 'event-a',
      result: { ...result, resultId: 'event-b' },
    },
  },
  {
    success: true,
    data: {
      sessionId: 'session-a',
      eventId: 'event-a',
      result: { ...result, url: 'https://secret.test' },
    },
  },
  {
    success: false,
    data: { sessionId: 'session-a', eventId: 'event-a', result },
  },
])(
  'tool-result client rejects malformed or non-success envelopes',
  async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: body.success ? 200 : 404,
        }),
      ),
    );
    await expect(
      getSessionToolResult('http://station.test', 'session-a', 'event-a'),
    ).rejects.toMatchObject({
      name: 'TaskToolResultRequestError',
      message: 'Tool result unavailable',
    } satisfies Partial<TaskToolResultRequestError>);
  },
);

test.each([
  { targetId: 'tool-result/9:session-a/7:event-a' },
  { targetId: 'tool-result/9:session-a/7:event-a', private: 'secret' },
  {
    targetId: 'tool-result/9:session-a/7:event-a',
    createdAt: ['2026-08-25T', { privatePayload: 'CANARY' }],
  },
  {
    targetId: 'tool-result/9:session-a/7:event-a',
    createdAt: '2026-02-30T00:00:00.000Z',
  },
])(
  'tool-result attach rejects wrong tuple or extra server fields',
  async (data) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              id: 'link-a',
              sourceType: 'task',
              sourceId: 'task-a',
              targetType: 'tool_result',
              relationType: 'references_tool_result',
              confidence: 1,
              createdAt: '2026-08-25T00:00:00.000Z',
              source: 'user',
              ...data,
            },
          }),
        ),
      ),
    );
    await expect(
      attachTaskToolResultReference('http://station.test', 'task-a', {
        sessionId: 'session-a',
        eventId: 'event-a',
      }),
    ).rejects.toBeInstanceOf(TaskToolResultRequestError);
  },
);
