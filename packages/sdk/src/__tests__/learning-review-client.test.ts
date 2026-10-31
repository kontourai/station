import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import {
  fetchProjectLearning,
  fetchProjectLearningDetail,
} from '../client/learning-review';

const authority = {
  apiBase: 'http://learning.test',
  authorityKey: 'operator',
  isCurrent: () => true,
};
beforeEach(() =>
  setClientCredentialResolver(() => ({
    origin: authority.apiBase,
    requestAuthority: authority,
  })),
);
afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test('old-host non-JSON 404 retains its status and an actionable update remedy', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('Not found', { status: 404 })),
  );
  await expect(
    fetchProjectLearning(authority.apiBase, 'work', {
      requestScope: authority,
      projectId: 'project-id',
    }),
  ).rejects.toMatchObject({
    status: 404,
    message:
      'Learning review is unsupported on this host. Enable its Feature Preview or update this Station.',
  });
});
test('restricted projections reject identity payloads and remain value-free', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        success: true,
        data: { state: 'restricted', id: 'protected', body: 'private' },
      }),
    ),
  );
  await expect(
    fetchProjectLearningDetail(authority.apiBase, 'work', 'known', undefined, {
      requestScope: authority,
      projectId: 'project-id',
    }),
  ).rejects.toThrow();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ success: true, data: { state: 'restricted' } }),
    ),
  );
  expect(
    await fetchProjectLearningDetail(
      authority.apiBase,
      'work',
      'known',
      undefined,
      { requestScope: authority, projectId: 'project-id' },
    ),
  ).toEqual({ state: 'restricted' });
});

test('an owner refusal preserves structured error evidence for current-authority callers', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        {
          success: false,
          error: 'Source access changed',
          code: 'restricted',
          details: { source: 'withdrawn' },
        },
        { status: 403 },
      ),
    ),
  );
  await expect(
    fetchProjectLearning(authority.apiBase, 'work', {
      requestScope: authority,
      projectId: 'project-id',
    }),
  ).rejects.toMatchObject({
    status: 403,
    code: 'restricted',
    details: { source: 'withdrawn' },
  });
});
