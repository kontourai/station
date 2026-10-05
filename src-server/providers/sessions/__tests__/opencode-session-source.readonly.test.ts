import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { OpenCodeSessionSource } from '../opencode-session-source.js';
import { OpenCodeFixtureWriter } from './opencode-fixture.js';

const opened = vi.hoisted(
  () => [] as Array<{ path: string; options: unknown }>,
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
      opened.push({ path, options });
      if (options === undefined) super(path);
      else super(path, options);
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

test('an unchanged store is answered without opening it, and a change is read again', async () => {
  const dataDir = join(
    realpathSync(tempDir('station-opencode-idle-')),
    'opencode',
  );
  writer = new OpenCodeFixtureWriter(dataDir);
  writer.session('ses_main', '/workspace/project');
  const user = writer.user('ses_main', ['Hello']);
  const answer = writer.assistant('ses_main', user, { finish: 'stop' });
  writer.text('ses_main', answer, 'Hi.');

  const source = new OpenCodeSessionSource({ dataDir });
  const session = (await source.discover()).sessions[0]!;
  const first = await source.read(session);
  expect(first.events.length).toBeGreaterThan(0);

  // An idle poll: same discovery, nothing new, and no connection opened.
  const before = opened.length;
  expect((await source.discover()).sessions).toEqual([session]);
  expect(await source.read(session, first.cursor)).toEqual({
    outcome: 'ok',
    events: [],
    cursor: first.cursor,
  });
  expect(opened.length).toBe(before);

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
  expect(opened.length).toBeGreaterThan(before);
});
