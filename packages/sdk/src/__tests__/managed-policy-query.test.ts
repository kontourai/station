import { afterEach, expect, test, vi } from 'vitest';
import { fetchManagedPolicyStatus } from '../query-domains/managedPolicy';

const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../client/http', () => ({ authenticatedFetch: network.fetch }));
afterEach(() => network.fetch.mockReset());

test('the status fetch awaits decoding and refuses malformed policy status', async () => {
  const requestScope = {
    apiBase: 'https://station.example',
    authorityKey: 'policy-reader',
  };
  const signal = new AbortController().signal;
  const loaded = {
    state: 'loaded',
    source: { kind: 'file', location: '/etc/station/policy.json' },
    digest: `sha256:${'a'.repeat(64)}`,
    summary: {
      organization: 'Acme',
      supportUrl: null,
      lockedSettings: [],
      limits: { telemetry: false, maxApprovalMode: 'ask' },
    },
  };
  network.fetch.mockResolvedValueOnce(
    Response.json({ success: true, data: loaded }),
  );
  await expect(
    fetchManagedPolicyStatus('https://station.example', {
      requestScope,
      signal,
    }),
  ).resolves.toEqual(loaded);
  expect(network.fetch).toHaveBeenCalledWith(
    'https://station.example/api/settings/managed-policy',
    { requestScope, signal },
  );
  network.fetch.mockResolvedValueOnce(
    Response.json({
      success: true,
      data: {
        ...loaded,
        summary: { ...loaded.summary, limits: { telemetry: true } },
      },
    }),
  );
  await expect(
    fetchManagedPolicyStatus('https://station.example'),
  ).rejects.toThrow('The managed policy status was not readable.');
});

test('only a missing route means an older unmanaged host; other failures remain errors', async () => {
  network.fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
  await expect(
    fetchManagedPolicyStatus('https://station.example'),
  ).resolves.toEqual({ state: 'none' });
  network.fetch.mockResolvedValueOnce(
    Response.json({ success: false, error: 'Unavailable' }, { status: 503 }),
  );
  await expect(
    fetchManagedPolicyStatus('https://station.example'),
  ).rejects.toThrow('Unavailable');
});
