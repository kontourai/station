import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ConversationPullRequestLinkStore } from '../conversation-pull-request-link-store.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});
const create = () => {
  const root = mkdtempSync(join(tmpdir(), 'station-pr-links-'));
  roots.push(root);
  return { root, store: new ConversationPullRequestLinkStore(root) };
};
const identity = (host: string, owner = 'team') => ({
  provider: 'github',
  host,
  repository: { owner, name: 'repo' },
  ref: '17',
});

test('persists exact same-number identities across restart and unlinks only one', async () => {
  const { root, store } = create();
  await store.link(
    'conversation-1',
    identity('one.test'),
    'operator',
    () => true,
  );
  await store.link(
    'conversation-1',
    identity('two.test', 'another'),
    'operator',
    () => true,
  );
  const restarted = new ConversationPullRequestLinkStore(root);
  expect(restarted.list('conversation-1').map((link) => link.host)).toEqual([
    'one.test',
    'two.test',
  ]);
  await restarted.unlink('conversation-1', identity('one.test'), () => true);
  expect(store.list('conversation-1')).toMatchObject([
    { host: 'two.test', repository: { owner: 'another' }, ref: '17' },
  ]);
});

test('joins concurrent writers and makes duplicate linking idempotent', async () => {
  const { root, store } = create();
  const peer = new ConversationPullRequestLinkStore(root);
  await Promise.all([
    store.link('conversation-1', identity('one.test'), 'operator', () => true),
    peer.link('conversation-1', identity('two.test'), 'operator', () => true),
  ]);
  await store.link(
    'conversation-1',
    identity('one.test'),
    'operator',
    () => true,
  );
  expect(peer.list('conversation-1')).toHaveLength(2);
});

test('rechecks authority inside the lock before durable publication', async () => {
  const { root, store } = create();
  let reads = 0;
  await expect(
    store.link('conversation-1', identity('one.test'), 'operator', () => {
      reads += 1;
      return reads < 2;
    }),
  ).rejects.toThrow('authorization changed');
  expect(store.list('conversation-1')).toEqual([]);
  expect(() =>
    readFileSync(join(root, 'conversation-pull-request-links.json'), 'utf8'),
  ).toThrow();
});

test('rejects traversal, invalid actors, and over-capacity identities', async () => {
  const { store } = create();
  await expect(
    store.link('../outside', identity('one.test'), 'operator', () => true),
  ).rejects.toThrow('authorization changed');
  await expect(
    store.link('conversation-1', identity('bad host'), 'operator', () => true),
  ).rejects.toThrow('identity is invalid');
});
