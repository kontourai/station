import { afterEach, expect, test, vi } from 'vitest';
import {
  attachTaskUserInputReference,
  getTaskUserInputReferences,
  TaskUserInputReferenceRequestError,
} from '../client/task-user-input-references.js';

afterEach(() => vi.unstubAllGlobals());

test('user-input reference client owns exact encoded routes and typed attach body', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: { id: 'link-1' } })),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: [
            {
              id: 'link-1',
              state: 'available',
              sessionId: 'session/1',
              eventId: 'event/1',
              turnId: 'turn-1',
              input: {
                prompt: 'Authorized input',
                attachments: [
                  { name: 'notes.txt', mediaType: 'text/plain', size: 16 },
                ],
              },
            },
            { state: 'unavailable' },
          ],
        }),
      ),
    );
  vi.stubGlobal('fetch', fetch);

  await expect(
    attachTaskUserInputReference('http://station.test', 'task/a', {
      sessionId: 'session/1',
      eventId: 'event/1',
      sourceSurface: 'cli',
    }),
  ).resolves.toEqual({ id: 'link-1' });
  await expect(
    getTaskUserInputReferences('http://station.test', 'task/a'),
  ).resolves.toEqual([
    {
      id: 'link-1',
      state: 'available',
      sessionId: 'session/1',
      eventId: 'event/1',
      turnId: 'turn-1',
      input: {
        prompt: 'Authorized input',
        attachments: [{ name: 'notes.txt', mediaType: 'text/plain', size: 16 }],
      },
    },
    { state: 'unavailable' },
  ]);

  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    'http://station.test/api/tasks/task%2Fa/references',
    'http://station.test/api/tasks/task%2Fa/user-input-references',
  ]);
  expect(fetch.mock.calls[0]?.[1]).toEqual(
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        kind: 'user-input',
        sessionId: 'session/1',
        eventId: 'event/1',
        sourceSurface: 'cli',
      }),
    }),
  );
});

test('user-input reference client rejects protected server diagnostics generically', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: 'Input from session secret-session: private words',
          details: { eventId: 'event-secret', content: 'private words' },
        }),
        { status: 404 },
      ),
    ),
  );

  await expect(
    getTaskUserInputReferences('http://station.test', 'task-a'),
  ).rejects.toMatchObject({
    name: 'TaskUserInputReferenceRequestError',
    message: 'User input reference unavailable',
    status: 404,
  } satisfies Partial<TaskUserInputReferenceRequestError>);
});
