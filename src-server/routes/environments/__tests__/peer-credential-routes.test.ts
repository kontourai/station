import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { PeerCredentialStore } from '../../../services/peers/peer-credential-store.js';
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
    upsert: vi.fn(
      (..._args: Parameters<PeerCredentialStore['upsert']>) => summary,
    ),
    remove: vi.fn(
      (..._args: Parameters<PeerCredentialStore['remove']>) => true,
    ),
    get: vi.fn((): (typeof summary & { credential: string }) | null => ({
      ...summary,
      credential: 'the-actual-secret',
    })),
  };
}

const wireHomes: string[] = [];
afterAll(() => {
  for (const dir of wireHomes) rmSync(dir, { recursive: true, force: true });
});

describe('peer credential routes (station#1123 slice 2)', () => {
  test('the list wire shape from a REAL store carries no credential material (#790)', async () => {
    // The mocked-store tests above prove the route passes `list()` through;
    // this proves the composed wire shape — real store, real routes — never
    // grows a credential field. The UI (Computers page, Delegate dialog)
    // renders exactly this payload.
    const homeDir = mkdtempSync(join(tmpdir(), 'station-peer-route-wire-'));
    wireHomes.push(homeDir);
    const store = new PeerCredentialStore(homeDir);
    const secret = 'wire-shape-secret-0123456789abcdef';
    await store.upsert({
      environmentId: 'env-peer-wire',
      apiBase: 'https://box-b.example.test',
      scope: 'orchestration:read orchestration:operate',
      credential: secret,
      label: 'box-b',
    });
    const app = createPeerCredentialRoutes(store);
    const response = await app.request('/');
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('"credential"');
    const body = JSON.parse(raw) as {
      success: boolean;
      data: Array<Record<string, unknown>>;
    };
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(Object.keys(body.data[0]).sort()).toEqual([
      'apiBase',
      'createdAt',
      'environmentId',
      'label',
      'scope',
      'updatedAt',
    ]);
  });

  test('lists and creates through typed routes, never returning a credential', async () => {
    const mock = store();
    const authorize = vi.fn(() => true);
    const app = createPeerCredentialRoutes(mock as any, undefined, authorize);

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
    expect(mock.upsert).toHaveBeenCalledWith(
      {
        environmentId: 'environment-peer-b',
        apiBase: 'https://box-b.example.test',
        credential: 'peer-bearer-credential-0123456789abcdef',
        scope: 'orchestration:read orchestration:operate',
        label: 'box-b',
      },
      expect.any(Function),
    );
    const current = mock.upsert.mock.calls[0]?.[1];
    expect(current?.()).toBe(true);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(await json(created))).not.toContain(
      'peer-bearer-credential-0123456789abcdef',
    );
  });

  test('removes an existing environmentId and 404s a missing one', async () => {
    const mock = store();
    const app = createPeerCredentialRoutes(mock as any, undefined, () => true);

    const removed = await app.request('/environment-peer-b', {
      method: 'DELETE',
    });
    expect(removed.status).toBe(200);
    expect(mock.remove).toHaveBeenCalledWith(
      'environment-peer-b',
      expect.any(Function),
    );

    mock.remove.mockReturnValueOnce(false);
    const missing = await app.request('/environment-nowhere', {
      method: 'DELETE',
    });
    expect(missing.status).toBe(404);
  });

  test('fails closed for public mutations when no current-caller authorizer is composed', async () => {
    const mock = store();
    const app = createPeerCredentialRoutes(mock as any);

    const created = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        environmentId: 'environment-peer-b',
        apiBase: 'https://box-b.example.test',
        credential: 'peer-bearer-credential-0123456789abcdef',
        scope: 'orchestration:read',
      }),
    });
    const removed = await app.request('/environment-peer-b', {
      method: 'DELETE',
    });

    expect(created.status).toBe(403);
    expect(removed.status).toBe(403);
    expect(mock.upsert).not.toHaveBeenCalled();
    expect(mock.remove).not.toHaveBeenCalled();
  });

  test('withholds a peer write when caller authority is revoked while its file lock is queued', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'station-peer-route-lock-'));
    wireHomes.push(homeDir);
    const seeded = new PeerCredentialStore(homeDir);
    await seeded.upsert({
      environmentId: 'environment-existing',
      apiBase: 'https://existing.example.test',
      scope: 'orchestration:read',
      credential: 'existing-credential-0123456789abcdef',
    });
    let current = true;
    const guarded = new PeerCredentialStore(homeDir, {
      acquireMutationLock: async () => {
        current = false;
        return () => {};
      },
    });
    const app = createPeerCredentialRoutes(guarded, undefined, () => current);

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        environmentId: 'environment-revoked',
        apiBase: 'https://revoked.example.test',
        credential: 'revoked-credential-0123456789abcdef',
        scope: 'orchestration:read',
      }),
    });

    expect(response.status).toBe(403);
    expect(new PeerCredentialStore(homeDir).list()).toEqual([
      expect.objectContaining({ environmentId: 'environment-existing' }),
    ]);
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
      const app = createPeerCredentialRoutes(
        mock as any,
        hasSshProfile,
        () => true,
      );

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
      const app = createPeerCredentialRoutes(
        mock as any,
        hasSshProfile,
        () => true,
      );

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

      const noLookupApp = createPeerCredentialRoutes(
        mock as any,
        undefined,
        () => true,
      );
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
