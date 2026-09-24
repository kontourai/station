import { expect, test, vi } from 'vitest';
import {
  parseTranscriptReadRequest,
  parseTranscriptReadResult,
  transcriptMessageRequest,
} from '../transcript-search-protocol.js';

const request = {
  type: 'message-search',
  id: 1,
  query: 'cobalt',
  ownerUserId: 'phone',
  limit: 4,
};
test('personal owner aliases cross the private worker protocol, but never with a tenant scope', () => {
  const aliases = ['phone', 'desktop'];
  expect(
    parseTranscriptReadRequest({ ...request, ownerUserIds: aliases }),
  ).toMatchObject({ ownerUserIds: aliases });
  expect(
    transcriptMessageRequest(
      {
        query: 'cobalt',
        ownerUserId: 'phone',
        ownerUserIds: aliases,
        limit: 4,
      },
      1,
    ),
  ).toMatchObject({ ownerUserIds: aliases });
  expect(
    parseTranscriptReadRequest({
      ...request,
      ownerUserIds: aliases,
      tenantId: 'tenant-a',
    }),
  ).toBeNull();
});
test('owner alias lists are bounded and cannot execute accessors', () => {
  expect(
    parseTranscriptReadRequest({ ...request, ownerUserIds: [] }),
  ).toBeNull();
  expect(
    parseTranscriptReadRequest({
      ...request,
      ownerUserIds: Array(257).fill('owner'),
    }),
  ).toBeNull();
  expect(
    parseTranscriptReadRequest({ ...request, ownerUserIds: ['x'.repeat(257)] }),
  ).toBeNull();
  const read = vi.fn(() => 'owner');
  const aliases = new Array<string>(1);
  Object.defineProperty(aliases, '0', { get: read });
  expect(
    parseTranscriptReadRequest({ ...request, ownerUserIds: aliases }),
  ).toBeNull();
  expect(read).not.toHaveBeenCalled();
});

/**
 * #2460: the worker's refusal carries its error CLASS so the owner's log can
 * name it. The wire accepts exactly the bounded class fields — a message, or
 * any free text that could quote a query or a transcript, is refused.
 */
test('an unavailable reply carries only a bounded worker-authored cause', () => {
  const parsed = parseTranscriptReadRequest(request)!;
  const cause = {
    kind: 'query-error',
    name: 'Error',
    code: 'ERR_SQLITE_ERROR',
    errcode: 1,
  };
  expect(
    parseTranscriptReadResult({ state: 'unavailable', cause }, parsed),
  ).toEqual({ state: 'unavailable', cause });
  expect(parseTranscriptReadResult({ state: 'unavailable' }, parsed)).toEqual({
    state: 'unavailable',
  });
  for (const invalid of [
    { ...cause, message: 'no such table: secret query' },
    { ...cause, kind: 'worker-exit' },
    { ...cause, name: 'has spaces and a query' },
    { ...cause, code: 'lowercase' },
    { ...cause, errcode: 1.5 },
    { name: 'Error' },
  ])
    expect(
      parseTranscriptReadResult(
        { state: 'unavailable', cause: invalid },
        parsed,
      ),
    ).toBeNull();
  expect(
    parseTranscriptReadResult({ state: 'available', rows: [], cause }, parsed),
  ).toBeNull();
});
