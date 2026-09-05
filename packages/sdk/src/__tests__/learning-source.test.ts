import { afterEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import { observeLearningSource } from '../client/learning-source';

const reference = {
  rootId: 'root:personal',
  recordId: 'source-a',
  rootIdentity: '["Mémoire 🧠"]',
};
const observed = {
  state: 'observed',
  kind: 'source-only',
  source: {
    rootId: reference.rootId,
    recordId: reference.recordId,
    adapterId: 'kit-default-store',
    type: 'raw',
    title: 'Source title',
    category: 'feedback',
    body: 'Source body',
    provenance: { agent: 'source-owner' },
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    status: 'active',
  },
  observation: {
    observedAt: '2026-09-04T00:00:00Z',
    contentDigest: 'a'.repeat(64),
    ownerRevision: 'unknown',
    consistency: 'non-atomic',
    transactionState: 'unknown',
  },
};
function reply(data: unknown) {
  return new Response(JSON.stringify({ success: true, data }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
});
test('source fetch uses encoded exact registration precondition and strips unowned lifecycle fields', async () => {
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) =>
    reply({ ...observed, activation: { status: 'active' } }),
  );
  vi.stubGlobal('fetch', fetch);
  const result = await observeLearningSource(
    'https://station.test/api',
    reference,
  );
  expect(String(fetch.mock.calls[0][0])).toContain(
    'root%3Apersonal/records/source-a/source-observation',
  );
  const headers = new Headers(
    (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers,
  );
  expect(headers.get('x-station-knowledge-root-identity')).toBe(
    encodeURIComponent(reference.rootIdentity),
  );
  expect(result).toEqual(observed);
  expect(result).not.toHaveProperty('activation');
});
test('restricted observations discard protected identity and mismatched sources are rejected', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      reply({ state: 'restricted', source: observed.source }),
    )
    .mockResolvedValueOnce(
      reply({
        ...observed,
        source: { ...observed.source, recordId: 'foreign' },
      }),
    );
  vi.stubGlobal('fetch', fetch);
  expect(
    await observeLearningSource('https://station.test/api', reference),
  ).toEqual({ state: 'restricted' });
  await expect(
    observeLearningSource('https://station.test/api', reference),
  ).rejects.toThrow('Invalid source observation');
});
test('a stale Station authority cannot dispatch source inspection', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  setClientCredentialResolver(() => ({
    origin: 'https://station.test',
    credential: 'fixture',
    requestAuthority: {
      apiBase: 'https://station.test/api',
      authorityKey: 'new',
    },
  }));
  await expect(
    observeLearningSource('https://station.test/api', reference, {
      requestScope: {
        apiBase: 'https://station.test/api',
        authorityKey: 'old',
      },
    }),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
