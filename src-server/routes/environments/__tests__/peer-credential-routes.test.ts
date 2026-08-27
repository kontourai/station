import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { getInternalApiToken } from '../../../utils/internal-api-token.js';
import { createPeerCredentialRoutes } from '../peer-credential-routes.js';

function store() {
  const summary = {
    environmentId: 'environment-peer-b',
    apiBase: 'https://box-b.example.test',
    scope: 'orchestration:read orchestration:operate',
    label: 'box-b',
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    list: vi.fn(() => [summary]),
    upsert: vi.fn(() => summary),
    remove: vi.fn(() => true),
    get: vi.fn((): (typeof summary & { credential: string }) | null => ({
      ...summary,
      credential: 'the-actual-secret',
    })),
  };
}

describe('peer credential routes (station#1123 slice 2)', () => {
  test('lists and creates through typed routes, never returning a credential', async () => {
    const mock = store();
    const app = createPeerCredentialRoutes(mock as any);

    const list = await json<{ success: boolean; data: unknown[] }>(
      await app.request('/'),
    );
    expect(list).toEqual({ success: true, data: [expect.any(Object)] });
    expect(JSON.stringify(list)).not.toContain('the-actual-secret');

    const created = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        environmentId: 'environment-peer-b',
        apiBase: 'https://box-b.example.test',
        credential: 'peer-bearer-credential-0123456789abcdef',
        scope: 'orchestration:read orchestration:operate',
        label: 'box-b',
      }),
    });
    expect(created.status).toBe(201);
    expect(mock.upsert).toHaveBeenCalledWith({
      environmentId: 'environment-peer-b',
      apiBase: 'https://box-b.example.test',
      credential: 'peer-bearer-credential-0123456789abcdef',
      scope: 'orchestration:read orchestration:operate',
      label: 'box-b',
    });
    expect(JSON.stringify(await json(created))).not.toContain(
      'peer-bearer-credential-0123456789abcdef',
    );
  });

  test('removes an existing environmentId and 404s a missing one', async () => {
    const mock = store();
    const app = createPeerCredentialRoutes(mock as any);

    const removed = await app.request('/environment-peer-b', {
      method: 'DELETE',
    });
    expect(removed.status).toBe(200);
    expect(mock.remove).toHaveBeenCalledWith('environment-peer-b');

    mock.remove.mockReturnValueOnce(false);
    const missing = await app.request('/environment-nowhere', {
      method: 'DELETE',
    });
    expect(missing.status).toBe(404);
  });

  test("the credential leaf 403s any request not carrying this Station's own internal API token", async () => {
    const mock = store();
    const app = createPeerCredentialRoutes(mock as any);

    const noToken = await app.request('/environment-peer-b/credential');
    expect(noToken.status).toBe(403);
    expect(mock.get).not.toHaveBeenCalled();

    const wrongToken = await app.request('/environment-peer-b/credential', {
      headers: { 'x-station-internal-token': 'not-the-real-token' },
    });
    expect(wrongToken.status).toBe(403);
    expect(mock.get).not.toHaveBeenCalled();
  });

  test('the credential leaf returns the raw secret only to an internally attested caller', async () => {
    const mock = store();
    const app = createPeerCredentialRoutes(mock as any);

    const response = await app.request('/environment-peer-b/credential', {
      headers: { 'x-station-internal-token': getInternalApiToken() },
    });
    expect(response.status).toBe(200);
    const body = await json<{
      success: boolean;
      data: { credential: string; apiBase: string };
    }>(response);
    expect(body.data.credential).toBe('the-actual-secret');
    expect(body.data.apiBase).toBe('https://box-b.example.test');
  });

  test('the credential leaf 404s a missing environmentId even when internally attested', async () => {
    const mock = store();
    mock.get.mockReturnValueOnce(null);
    const app = createPeerCredentialRoutes(mock as any);

    const response = await app.request('/environment-nowhere/credential', {
      headers: { 'x-station-internal-token': getInternalApiToken() },
    });
    expect(response.status).toBe(404);
  });

  describe('SSH-precedence warning (review fix, PR #1178)', () => {
    test('adds a non-blocking warning when the environmentId already has an SSH profile', async () => {
      const mock = store();
      const hasSshProfile = vi.fn(() => true);
      const app = createPeerCredentialRoutes(mock as any, hasSshProfile);

      const created = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          environmentId: 'environment-peer-b',
          apiBase: 'https://box-b.example.test',
          credential: 'peer-bearer-credential-0123456789abcdef',
          scope: 'orchestration:read orchestration:operate',
        }),
      });

      expect(created.status).toBe(201);
      expect(hasSshProfile).toHaveBeenCalledWith('environment-peer-b');
      // Still provisions — the warning is advisory, not a refusal.
      expect(mock.upsert).toHaveBeenCalled();
      const body = await json<{ success: boolean; warning?: string }>(created);
      expect(body.warning).toContain(
        "Environment 'environment-peer-b' already has a saved SSH profile",
      );
    });

    test('omits the warning when no SSH profile matches, or when no lookup is provided', async () => {
      const mock = store();
      const hasSshProfile = vi.fn(() => false);
      const app = createPeerCredentialRoutes(mock as any, hasSshProfile);

      const created = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          environmentId: 'environment-peer-b',
          apiBase: 'https://box-b.example.test',
          credential: 'peer-bearer-credential-0123456789abcdef',
          scope: 'orchestration:read orchestration:operate',
        }),
      });
      const body = await json<{ warning?: string }>(created);
      expect(body.warning).toBeUndefined();

      const noLookupApp = createPeerCredentialRoutes(mock as any);
      const createdNoLookup = await noLookupApp.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          environmentId: 'environment-peer-b',
          apiBase: 'https://box-b.example.test',
          credential: 'peer-bearer-credential-0123456789abcdef',
          scope: 'orchestration:read orchestration:operate',
        }),
      });
      const bodyNoLookup = await json<{ warning?: string }>(createdNoLookup);
      expect(bodyNoLookup.warning).toBeUndefined();
    });
  });
});
