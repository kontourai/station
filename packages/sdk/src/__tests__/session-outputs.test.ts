import { afterEach, expect, test, vi } from 'vitest';
import {
  inspectSessionOutput,
  listSessionOutputs,
  SessionOutputsRequestError,
} from '../client/session-outputs.js';

afterEach(() => vi.unstubAllGlobals());

const item = {
  ref: { sessionId: 'session-a', eventId: 'event-a' },
  turnId: 'turn-a',
  toolCallId: 'call-a',
  declaredAt: '2026-08-26T00:00:00.000Z',
  descriptor: {
    kind: 'workspace-file',
    relativePath: 'result.txt',
    digest: 'a'.repeat(64),
    length: 2,
  },
};

test('accepts only exact Session Outputs response shapes and requested identities', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            version: 'session-outputs/v1',
            items: [item],
            partial: false,
          },
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            version: 'session-outputs/v1',
            item: { ...item, ref: { ...item.ref, eventId: 'other' } },
            kind: 'metadata',
          },
        }),
      ),
    );
  vi.stubGlobal('fetch', fetch);
  await expect(
    listSessionOutputs('http://station.test', 'session-a'),
  ).resolves.toMatchObject({ items: [{ ref: item.ref }] });
  await expect(
    inspectSessionOutput('http://station.test', 'session-a', 'event-a'),
  ).rejects.toBeInstanceOf(SessionOutputsRequestError);
});

test('rejects unknown keys and incomplete descriptor unions', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            version: 'session-outputs/v1',
            items: [{ ...item, extra: true }],
            partial: false,
          },
        }),
      ),
    ),
  );
  await expect(
    listSessionOutputs('http://station.test', 'session-a'),
  ).rejects.toBeInstanceOf(SessionOutputsRequestError);
});
