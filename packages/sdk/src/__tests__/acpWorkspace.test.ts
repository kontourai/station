import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: async () => 'http://station.test',
}));

const authenticatedFetch = vi.hoisted(() => vi.fn());
vi.mock('../client/http', () => ({ authenticatedFetch }));

const { connectAndMaterializeACPRegistryEngine } = await import(
  '../query-domains/acpWorkspace'
);

describe('connectAndMaterializeACPRegistryEngine', () => {
  beforeEach(() => authenticatedFetch.mockReset());

  test('returns the materialized Agent receipt including an adopted name', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          agent: {
            data: { slug: 'my-kiro', name: 'My Kiro' },
            created: false,
          },
        }),
      ),
    );

    await expect(
      connectAndMaterializeACPRegistryEngine('kiro'),
    ).resolves.toEqual({
      data: { slug: 'my-kiro', name: 'My Kiro' },
      created: false,
    });
  });

  test.each([
    ['a string error', 'Kiro CLI is unavailable', 'Kiro CLI is unavailable'],
    [
      'an object error with correlation',
      { code: 'internal_error', correlationId: 'corr-123' },
      'Failed to connect engine (internal_error; correlation ID: corr-123).',
    ],
    ['a missing error', undefined, 'Failed to connect engine'],
  ])('formats %s', async (_label, error, message) => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error }), { status: 500 }),
    );

    await expect(
      connectAndMaterializeACPRegistryEngine('kiro'),
    ).rejects.toThrow(message);
  });

  test('preserves an explicit 409 message', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          error: "Connection 'kiro' already exists",
        }),
        { status: 409 },
      ),
    );

    await expect(
      connectAndMaterializeACPRegistryEngine('kiro'),
    ).rejects.toThrow("Connection 'kiro' already exists");
  });
});
