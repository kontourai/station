import type { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { bodyDefinitions } from '../turn-bodies.js';
import { turnFixture } from './turn-fixture.js';

function removeChangeTracking(database: DatabaseSync) {
  for (const row of database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='trigger' AND name GLOB 'agent_steps_track_*'",
    )
    .all())
    database.exec(`DROP TRIGGER ${String(row.name)}`);
  database.exec('DROP TABLE agent_steps_changes');
  database.exec('DROP TABLE agent_steps_body_nodes');
  database.exec('DROP TABLE agent_steps_body_chunks');
  database.exec('DROP TABLE agent_steps_frame_blocks');
  database.exec(
    'DROP TABLE agent_steps_retained; DROP INDEX agent_steps_terminal_age',
  );
  database.exec('DROP TRIGGER agent_steps_bodies_no_delete');
  database.exec(bodyDefinitions[2]);
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('migration from the ownership writer preserves original turn bytes and future writers refuse', async () => {
  const f = await turnFixture();
  cleanup.push(() => f.close());
  const current = f.database
    .prepare('SELECT record FROM agent_steps_turns')
    .get()?.record;
  if (typeof current !== 'string')
    throw Error('real ownership record prerequisite');
  const legacy = JSON.parse(current);
  delete legacy.cancelRequested;
  delete legacy.cancelRequestedAt;
  const before = JSON.stringify(legacy);
  f.database.prepare('UPDATE agent_steps_turns SET record=?').run(before);
  removeChangeTracking(f.database);
  f.database.exec(
    "DROP TABLE agent_steps_bodies; DROP TABLE agent_steps_frames; DROP TABLE agent_steps_terminal; DROP INDEX agent_steps_unresolved; DROP TABLE agent_steps_affinity; DROP TABLE agent_steps_approvals; DROP TABLE agent_steps_effects; DROP TABLE agent_steps_meta; CREATE TABLE agent_steps_meta(id INTEGER PRIMARY KEY CHECK(id=1), writer_format TEXT NOT NULL CHECK(writer_format='agent-steps/1')) STRICT; INSERT INTO agent_steps_meta VALUES(1,'agent-steps/1');",
  );
  await f.crash.reopen();
  expect(
    f.database.prepare('SELECT record FROM agent_steps_turns').get()?.record,
  ).toBe(before);
  expect(
    f.database.prepare('SELECT writer_format FROM agent_steps_meta').get()
      ?.writer_format,
  ).toBe('agent-steps/11');
  f.database.exec(
    "DROP TABLE agent_steps_meta; CREATE TABLE agent_steps_meta(id INTEGER PRIMARY KEY, writer_format TEXT NOT NULL) STRICT; INSERT INTO agent_steps_meta VALUES(1,'agent-steps/99');",
  );
  await expect(f.crash.reopen()).rejects.toThrow('WRITER_UNSUPPORTED');
});

it('writer-5 migration retains the original turn bytes', async () => {
  const f = await turnFixture();
  cleanup.push(() => f.close());
  const before = f.database
    .prepare('SELECT record FROM agent_steps_turns')
    .get()?.record;
  removeChangeTracking(f.database);
  f.database.exec(
    "DROP INDEX agent_steps_effect_states; DROP TABLE agent_steps_bodies; DROP TABLE agent_steps_meta; CREATE TABLE agent_steps_meta(id INTEGER PRIMARY KEY CHECK(id=1), writer_format TEXT NOT NULL CHECK(writer_format='agent-steps/5')) STRICT; INSERT INTO agent_steps_meta VALUES(1,'agent-steps/5');",
  );
  await f.crash.reopen();
  expect(
    f.database.prepare('SELECT record FROM agent_steps_turns').get()?.record,
  ).toBe(before);
  expect(
    f.database.prepare('SELECT writer_format FROM agent_steps_meta').get()
      ?.writer_format,
  ).toBe('agent-steps/11');
});
