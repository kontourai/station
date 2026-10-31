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

test('old-host non-JSON 404 remains an actionable unsupported result before JSON parsing', async () => {
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
    code: 'learning_review_unsupported',
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
