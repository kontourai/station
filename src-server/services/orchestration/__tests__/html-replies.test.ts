import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';

const makeTempDir = trackTempDirs();
test('EventStore deletes page bytes with each publishing member and rolls pages back when session deletion rolls back', () => {
  const file = join(makeTempDir('html-reply-deletion-'), 'events.sqlite');
  let store = new EventStore(file);
  for (const threadId of ['root', 'successor'])
    store.upsertSession({
      provider: 'codex',
      threadId,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  const root = store.htmlReplyPages().publish('root', 'conversation', {
    version: 1,
    html: '<h1>Root page</h1>',
    height: 400,
  });
  const child = store.htmlReplyPages().publish('successor', 'conversation', {
    version: 1,
    html: '<h1>Successor page</h1>',
    height: 400,
  });
  store.close();
  store = new EventStore(file);
  const peer = new DatabaseSync(file);
  try {
    expect(store.htmlReplyPages().read(root)?.html).toBe('<h1>Root page</h1>');
    peer.exec(
      "CREATE TRIGGER refuse_session_delete BEFORE DELETE ON provider_session_state BEGIN SELECT RAISE(ABORT, 'injected deletion refusal'); END",
    );
    expect(() => store.deleteThread('root')).toThrow(
      'injected deletion refusal',
    );
    expect(store.htmlReplyPages().read(root)?.html).toBe('<h1>Root page</h1>');
    peer.exec('DROP TRIGGER refuse_session_delete');
    store.deleteThread('root');
    expect(store.htmlReplyPages().read(root)).toBeUndefined();
    expect(store.htmlReplyPages().read(child)?.html).toBe(
      '<h1>Successor page</h1>',
    );
    store.deleteThread('successor');
    expect(store.htmlReplyPages().read(child)).toBeUndefined();
    expect(() =>
      store.htmlReplyPages().publish('root', 'conversation', {
        version: 1,
        html: 'late write',
        height: 400,
      }),
    ).toThrow('no longer exists');
  } finally {
    peer.close();
    store.close();
  }
});

test('conversation page quota covers successive publishing sessions without truncating pages', () => {
  const file = join(makeTempDir('html-reply-quota-'), 'events.sqlite');
  const store = new EventStore(file);
  try {
    for (const threadId of ['root', 'successor'])
      store.upsertSession({
        provider: 'codex',
        threadId,
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    for (let i = 0; i < 32; i++)
      store.htmlReplyPages().publish('root', 'conversation', {
        version: 1,
        html: String(i),
        height: 400,
      });
    expect(() =>
      store.htmlReplyPages().publish('successor', 'conversation', {
        version: 1,
        html: 'over quota',
        height: 400,
      }),
    ).toThrow('32 pages');
  } finally {
    store.close();
  }
});
