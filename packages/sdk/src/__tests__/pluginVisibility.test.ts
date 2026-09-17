/**
 * The SDK's plugin-visibility domain (#2067).
 *
 * The Settings section's "render nothing for a non-operator" behaviour rests
 * entirely on `isPluginVisibilityForbidden(error)` being true for a real 403 —
 * and the section's own test mocks that predicate, so until this file the one
 * production mapping had no test at all and the branch it feeds was
 * unexercised. These cases drive the real fetchers against real `Response`
 * objects.
 */
import { beforeEach, expect, test, vi } from 'vitest';

const authenticatedFetch = vi.fn();

vi.mock('../api', () => ({ _getApiBase: async () => 'http://station.test' }));
vi.mock('../client/http', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

const {
  fetchPluginVisibility,
  isPluginVisibilityForbidden,
  PluginVisibilityForbiddenError,
} = await import('../query-domains/pluginVisibility');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(() => {
  authenticatedFetch.mockReset();
});

test('a real 403 becomes the forbidden error the Settings section keys on', async () => {
  // The exact body the route sends a non-operator.
  authenticatedFetch.mockResolvedValue(
    json(
      {
        success: false,
        error: 'Only the Station operator can change plugin visibility.',
      },
      403,
    ),
  );
  const error = await fetchPluginVisibility().catch(
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(PluginVisibilityForbiddenError);
  expect(isPluginVisibilityForbidden(error)).toBe(true);
});

test('an ordinary failure is NOT forbidden, so the section still reports it', () => {
  // The discriminating case. If `isPluginVisibilityForbidden` answered true
  // for any error, the section would render nothing for an operator whose
  // request merely failed — a capability silently missing instead of a
  // visible error.
  expect(isPluginVisibilityForbidden(new Error('network down'))).toBe(false);
  expect(isPluginVisibilityForbidden(undefined)).toBe(false);
  expect(isPluginVisibilityForbidden(null)).toBe(false);
});

test('a 400 from an unresolvable caller surfaces as an ordinary error', async () => {
  authenticatedFetch.mockResolvedValue(
    json({ success: false, error: 'Unable to resolve a principal' }, 400),
  );
  const error = await fetchPluginVisibility().catch(
    (thrown: unknown) => thrown,
  );
  expect(isPluginVisibilityForbidden(error)).toBe(false);
  expect((error as Error).message).toContain('Unable to resolve a principal');
});

test('a non-JSON body becomes a named failure, not a parse exception', async () => {
  authenticatedFetch.mockResolvedValue(
    new Response('<html>proxy error</html>', { status: 502 }),
  );
  const error = await fetchPluginVisibility().catch(
    (thrown: unknown) => thrown,
  );
  expect((error as Error).message).toBe(
    'Plugin visibility could not be listed',
  );
});

test('a successful read returns the directory', async () => {
  authenticatedFetch.mockResolvedValue(
    json({ success: true, data: { principals: [] } }),
  );
  await expect(fetchPluginVisibility()).resolves.toEqual({ principals: [] });
  expect(authenticatedFetch).toHaveBeenCalledWith(
    'http://station.test/api/plugins/visibility',
  );
});
