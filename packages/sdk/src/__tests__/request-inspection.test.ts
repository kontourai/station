import { afterEach, describe, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import { respondToRequest } from '../client/orchestration';
import {
  inspectAttentionRequest,
  parseAttentionRequestInspection,
} from '../client/request-inspection';

const reference = {
  threadId: 'session/a',
  requestId: 'request/a',
  requestEventId: 'event/a',
};
const inspection = {
  state: 'open',
  reference,
  requestType: 'permission',
  provider: 'claude',
  title: 'Approve fixture',
  openedAt: '2026-09-04T00:00:00Z',
  answerability: { answerable: true },
  canRespond: true,
};
afterEach(() => {
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
});
describe('exact request SDK boundary', () => {
  test('read and response retain exact encoded reference and expected event', async () => {
    const fetch = vi.fn(
      async (_url: unknown, init?: RequestInit) =>
        new Response(
          JSON.stringify(
            init?.method === 'POST'
              ? {
                  success: true,
                  data: null,
                  receipt: { commandId: 'receipt-a' },
                }
              : { success: true, data: inspection },
          ),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetch);
    expect(
      await inspectAttentionRequest('https://station.test', reference),
    ).toMatchObject(inspection);
    expect(String(fetch.mock.calls[0][0])).toContain(
      '/sessions/session%2Fa/requests/request%2Fa?eventId=event%2Fa',
    );
    await respondToRequest('https://station.test', {
      threadId: reference.threadId,
      requestId: reference.requestId,
      expectedRequestEventId: reference.requestEventId,
      decision: 'accept',
    });
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toMatchObject({
      type: 'respondToRequest',
      expectedRequestEventId: 'event/a',
    });
  });
  test('rejects retargeted or internally inconsistent responses', () => {
    expect(() =>
      parseAttentionRequestInspection(
        {
          ...inspection,
          reference: { ...reference, requestEventId: 'replacement' },
        },
        reference,
      ),
    ).toThrow(/match/);
    expect(() =>
      parseAttentionRequestInspection(
        { ...inspection, answerability: undefined },
        reference,
      ),
    ).toThrow(/answerability/);
    expect(() =>
      parseAttentionRequestInspection(
        { ...inspection, answerability: { answerable: false } },
        reference,
      ),
    ).toThrow(/answerability/);
  });
  test('a captured authority cannot send through a replacement credential scope', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    setClientCredentialResolver(() => ({
      origin: 'https://station.test',
      credential: 'fixture',
      requestAuthority: {
        apiBase: 'https://station.test',
        authorityKey: 'new',
        isCurrent: () => true,
      },
    }));
    await expect(
      inspectAttentionRequest('https://station.test', reference, {
        requestScope: { apiBase: 'https://station.test', authorityKey: 'old' },
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
