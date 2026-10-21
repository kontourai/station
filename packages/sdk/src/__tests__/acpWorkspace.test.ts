import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: async () => 'http://station.test',
}));

const authenticatedFetch = vi.hoisted(() => vi.fn());
vi.mock('../client/http', () => ({ authenticatedFetch }));

const { connectAndMaterializeACPRegistryEngine, recheckACPConnectionRegistry } =
  await import('../query-domains/acpWorkspace');

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

describe('recheckACPConnectionRegistry', () => {
  beforeEach(() => authenticatedFetch.mockReset());

  // The body the runtime's scope gate writes (runtime-http.ts).
  test('a scope denial reads as not permitted', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'insufficient_scope' } }), {
        status: 403,
      }),
    );
    await expect(recheckACPConnectionRegistry()).resolves.toEqual({
      status: 'not-permitted',
    });
  });

  test.each(['origin_required', 'origin_forbidden'])(
    'a %s refusal is an error, not a permission answer',
    async (code) => {
      authenticatedFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code } }), { status: 403 }),
      );
      await expect(recheckACPConnectionRegistry()).rejects.toThrow(code);
    },
  );

  test('a success returns the fresh entries', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: [{ id: 'kiro', name: 'Kiro CLI', command: 'kiro-cli' }],
        }),
      ),
    );
    await expect(recheckACPConnectionRegistry()).resolves.toEqual({
      status: 'rechecked',
      entries: [{ id: 'kiro', name: 'Kiro CLI', command: 'kiro-cli' }],
    });
  });
});
