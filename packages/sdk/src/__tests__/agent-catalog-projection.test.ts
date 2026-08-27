import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAgentCatalog, fetchAgentsEnriched } from '../client/agents';

/**
 * station#3751: `catalogState` reaches a consumer, or the Agents rail renders
 * a stale snapshot's readiness words with nothing saying they are stale.
 */
describe('fetchAgentCatalog', () => {
  beforeEach(() => vi.restoreAllMocks());

  function respond(body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => body,
      } as Response),
    );
  }

  it('carries the reconciling flag and its capture time', async () => {
    respond({
      success: true,
      data: [{ slug: 'writer' }],
      catalogState: 'reconciling',
      catalogAsOf: '2026-08-23T09:00:00.000Z',
    });

    await expect(fetchAgentCatalog('http://x.test')).resolves.toEqual({
      agents: [{ slug: 'writer' }],
      catalogState: 'reconciling',
      catalogAsOf: '2026-08-23T09:00:00.000Z',
    });
  });

  it('omits both fields on a live read rather than inventing them', async () => {
    respond({ success: true, data: [] });

    const projection = await fetchAgentCatalog('http://x.test');

    expect(projection).toEqual({ agents: [] });
    expect('catalogState' in projection).toBe(false);
    expect('catalogAsOf' in projection).toBe(false);
  });

  it('still throws the envelope error rather than reporting an empty catalog', async () => {
    respond({ success: false, error: 'agent catalog unavailable' });

    await expect(fetchAgentCatalog('http://x.test')).rejects.toThrow(
      'agent catalog unavailable',
    );
  });

  it('fetchAgentsEnriched keeps its array contract for the CLI', async () => {
    respond({ success: true, data: [{ slug: 'writer' }] });

    await expect(fetchAgentsEnriched('http://x.test')).resolves.toEqual([
      { slug: 'writer' },
    ]);
  });
});
