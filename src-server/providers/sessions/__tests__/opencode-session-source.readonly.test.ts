import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { OpenCodeSessionSource } from '../opencode-session-source.js';
import { OpenCodeFixtureWriter } from './opencode-fixture.js';

const opened = vi.hoisted(
  () =>
    [] as Array<{
      path: string;
      options: unknown;
      db: import('node:sqlite').DatabaseSync;
    }>,
);

// Observe every connection opened in this file. The fixture writer's own
// connection opens with no options; the source's must all be read-only.
vi.mock('node:sqlite', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:sqlite')>();
  class ObservedDatabaseSync extends real.DatabaseSync {
    constructor(
      path: string,
      options?: ConstructorParameters<typeof real.DatabaseSync>[1],
    ) {
      if (options === undefined) super(path);
      else super(path, options);
      opened.push({ path, options, db: this });
    }
  }
  return { ...real, DatabaseSync: ObservedDatabaseSync };
});

const tempDir = trackTempDirs();
let writer: OpenCodeFixtureWriter | undefined;
afterEach(() => {
  writer?.close();
  writer = undefined;
});

test('every connection the source opens to the OpenCode store is read-only', async () => {
  const dataDir = join(
    realpathSync(tempDir('station-opencode-ro-')),
    'opencode',
  );
  writer = new OpenCodeFixtureWriter(dataDir);
  writer.session('ses_main', '/workspace/project');
  const user = writer.user('ses_main', ['Hello']);
  const answer = writer.assistant('ses_main', user, { finish: 'stop' });
  writer.text('ses_main', answer, 'Hi.');
  const fixtureConnections = opened.length;

  const source = new OpenCodeSessionSource({ dataDir });
  const session = (await source.discover()).sessions[0]!;
  const read = await source.read(session);
  expect(read.events.length).toBeGreaterThan(0);

  const sourceConnections = opened.slice(fixtureConnections);
  // One connection serves the poll's discovery and its reads.
  expect(sourceConnections.length).toBe(1);
  for (const connection of sourceConnections) {
    expect(connection.path).toBe(writer.path);
    expect(connection.options).toMatchObject({ readOnly: true });
  }
});

test('an unchanged store is answered without querying its tables, and a change is read again', async () => {
  const dataDir = join(
    realpathSync(tempDir('station-opencode-idle-')),
    'opencode',
  );
  writer = new OpenCodeFixtureWriter(dataDir);
  writer.session('ses_main', '/workspace/project');
  const user = writer.user('ses_main', ['Hello']);
  const answer = writer.assistant('ses_main', user, { finish: 'stop' });
  writer.text('ses_main', answer, 'Hi.');

  const before = opened.length;
  const source = new OpenCodeSessionSource({ dataDir });
  const session = (await source.discover()).sessions[0]!;
  const first = await source.read(session);
  expect(first.events.length).toBeGreaterThan(0);
  const connection = opened.slice(before).find((entry) => entry.options)!;
  const statements: string[] = [];
  const prepare = connection.db.prepare.bind(connection.db);
  vi.spyOn(connection.db, 'prepare').mockImplementation((sql: string) => {
    statements.push(sql);
    return prepare(sql);
  });
  const touchesTables = () =>
    statements.some((sql) => /\bFROM (session|message|part)\b/u.test(sql));

  // An idle poll: same discovery, nothing new, only the change counter read.
  expect((await source.discover()).sessions).toEqual([session]);
  expect(await source.read(session, first.cursor)).toEqual({
    outcome: 'ok',
    events: [],
    cursor: first.cursor,
  });
  expect(statements.length).toBeGreaterThan(0);
  expect(statements.every((sql) => sql === 'PRAGMA data_version')).toBe(true);

  const next = writer.user('ses_main', ['More']);
  const reply = writer.assistant('ses_main', next, { finish: 'stop' });
  writer.text('ses_main', reply, 'Sure.');
  await source.discover();
  const second = await source.read(session, first.cursor);
  expect(second.events.map((event) => event.method)).toEqual([
    'turn.started',
    'content.text-delta',
    'turn.completed',
  ]);
  expect(touchesTables()).toBe(true);
  source.close();
});

function seededStore(prefix: string): string {
  const dataDir = join(realpathSync(tempDir(prefix)), 'opencode');
  writer = new OpenCodeFixtureWriter(dataDir);
  writer.session('ses_main', '/workspace/project');
  const user = writer.user('ses_main', ['Hello']);
  const answer = writer.assistant('ses_main', user, { finish: 'stop' });
  writer.text('ses_main', answer, 'Hi.');
  return dataDir;
}

test('a connection whose statement failed is closed, not leaked', async () => {
  const dataDir = seededStore('station-opencode-leak-');
  const source = new OpenCodeSessionSource({ dataDir, warn: () => {} });
  const before = opened.length;
  const session = (await source.discover()).sessions[0]!;
  const connection = opened.slice(before).find((entry) => entry.options);
  expect(connection?.db.isOpen).toBe(true);
  vi.spyOn(connection!.db, 'prepare').mockImplementation(() => {
    throw Object.assign(new Error('disk I/O error'), {
      code: 'ERR_SQLITE_ERROR',
    });
  });
  // The store changed, so the read cannot be answered from the drained cache.
  writer!.touch('ses_main');
  expect((await source.read(session)).outcome).toBe('rejected_candidate');
  expect(connection!.db.isOpen).toBe(false);
});

test('close releases every connection the source holds', async () => {
  const dataDir = seededStore('station-opencode-close-');
  const source = new OpenCodeSessionSource({ dataDir });
  const before = opened.length;
  const session = (await source.discover()).sessions[0]!;
  await source.read(session);
  const held = opened.slice(before).filter((entry) => entry.options);
  expect(held.length).toBeGreaterThan(0);
  expect(held.every((entry) => entry.db.isOpen)).toBe(true);
  source.close();
  expect(held.every((entry) => !entry.db.isOpen)).toBe(true);
});
