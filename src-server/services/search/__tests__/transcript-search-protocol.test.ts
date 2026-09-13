import { expect, test, vi } from 'vitest';
import {
  parseTranscriptReadRequest,
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
