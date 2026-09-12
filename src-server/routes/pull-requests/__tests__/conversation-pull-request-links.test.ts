import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationPullRequestLink } from '@kontourai/station-contracts/conversation-pull-request-links';
import { afterEach, expect, test, vi } from 'vitest';
import { ConversationPullRequestLinkStore } from '../../../services/pull-requests/conversation-pull-request-link-store.js';
import { createConversationPullRequestLinkRoutes } from '../conversation-pull-request-links.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});
const identity = {
  provider: 'github',
  host: 'forge.test',
  repository: { owner: 'team', name: 'repo' },
  ref: '17',
};
function fixture(
  declared: () => Promise<ConversationPullRequestLink[]> = async () => [],
) {
  const root = mkdtempSync(join(tmpdir(), 'station-pr-link-routes-'));
  roots.push(root);
  const authority = {
    current: true,
    read: true,
    actor: 'operator' as string | undefined,
  };
  const provider = {
    id: 'github',
    canServeHost: (host: string) => host === 'forge.test',
    getPullRequestByIdentity: vi.fn().mockResolvedValue({
      available: true,
      data: {
        ...identity,
        title: 'Exact change',
        state: 'OPEN',
        headSha: 'a'.repeat(40),
      },
    }),
  } as any;
  return {
    authority,
    provider,
    app: createConversationPullRequestLinkRoutes(
      new ConversationPullRequestLinkStore(root),
      () => [provider],
      {
        current: () => authority.current,
        canRead: () => authority.read,
        operator: () => authority.actor,
        declared,
      },
    ),
  };
}

test('validates exact provider identity before persisting and refreshes current head', async () => {
  const x = fixture();
  const created = await x.app.request('/conversation-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(identity),
  });
  expect(created.status).toBe(201);
  const read = await x.app.request('/conversation-1');
  expect(read.status).toBe(200);
  await expect(read.json()).resolves.toMatchObject({
    success: true,
    data: {
      conversationId: 'conversation-1',
      links: [
        {
          ...identity,
          source: 'explicit',
          status: {
            state: 'current',
            title: 'Exact change',
            head: 'a'.repeat(40),
          },
        },
      ],
    },
  });
  expect(x.provider.getPullRequestByIdentity).toHaveBeenCalledWith(
    { host: 'forge.test', repository: identity.repository },
    '17',
  );
});

test('does not persist a mismatched or unavailable provider observation', async () => {
  const x = fixture();
  x.provider.getPullRequestByIdentity.mockResolvedValueOnce({
    available: true,
    data: { ...identity, host: 'different.test' },
  });
  expect(
    (
      await x.app.request('/conversation-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(identity),
      })
    ).status,
  ).toBe(409);
  await expect(
    (await x.app.request('/conversation-1')).json(),
  ).resolves.toMatchObject({
    data: { links: [] },
  });
});

test('keeps partial refresh failures explicit and permits exact unlink', async () => {
  const x = fixture();
  await x.app.request('/conversation-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(identity),
  });
  x.provider.getPullRequestByIdentity.mockResolvedValueOnce({
    available: false,
    reason: 'Forge authorization expired',
  });
  await expect(
    (await x.app.request('/conversation-1')).json(),
  ).resolves.toMatchObject({
    data: {
      links: [
        {
          status: {
            state: 'unavailable',
            reason: 'Forge authorization expired',
          },
        },
      ],
    },
  });
  expect(
    (
      await x.app.request('/conversation-1', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(identity),
      })
    ).status,
  ).toBe(200);
});

test('denies unreadable conversations and rechecks authority before write', async () => {
  const x = fixture();
  x.authority.read = false;
  expect((await x.app.request('/conversation-1')).status).toBe(404);
  expect(
    (
      await x.app.request('/conversation-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(identity),
      })
    ).status,
  ).toBe(404);
  expect(x.provider.getPullRequestByIdentity).not.toHaveBeenCalled();
});

test('keeps Task-declared provenance distinct from the same explicit identity', async () => {
  const x = fixture(async () => [
    {
      ...identity,
      source: 'task-declared',
      linkedAt: '2026-09-12T00:00:00Z',
      linkedBy: 'station.task-graph',
    },
  ]);
  await x.app.request('/conversation-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(identity),
  });
  const body = (await (await x.app.request('/conversation-1')).json()) as {
    data: { links: Array<{ source: string }> };
  };
  expect(
    body.data.links.map((link: { source: string }) => link.source),
  ).toEqual(['explicit', 'task-declared']);
  expect(x.provider.getPullRequestByIdentity).toHaveBeenCalledTimes(3);
});
