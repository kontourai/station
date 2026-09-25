import {
  INTERNAL_SESSION_READ_SCOPE,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { expect, test } from 'vitest';
import {
  currentKnowledgeReadScope,
  currentRequestReadAuthority,
  runAsStationKnowledgeIndexer,
  runWithRequestReadAuthority,
} from '../request-read-authority-context.js';

const peer = sessionReadAuthorityFromRequest(
  'human:device:peer',
  undefined,
  undefined,
);

test('a request nested inside a Station build reads as that request, never with the internal scope', async () => {
  await runWithRequestReadAuthority(peer, () =>
    runAsStationKnowledgeIndexer(async () => {
      expect(currentKnowledgeReadScope()).toBe(INTERNAL_SESSION_READ_SCOPE);
      await runWithRequestReadAuthority(peer, async () => {
        // Across an await, too.
        await Promise.resolve();
        expect(currentKnowledgeReadScope()).toBe(peer);
        expect(currentRequestReadAuthority()).toBe(peer);
      });
      // The build's own scope is back once the nested request returns.
      expect(currentKnowledgeReadScope()).toBe(INTERNAL_SESSION_READ_SCOPE);
    }),
  );
});

test('outside any request or build nothing is readable', () => {
  expect(currentKnowledgeReadScope()).toBeUndefined();
  expect(currentRequestReadAuthority()).toBeUndefined();
});
