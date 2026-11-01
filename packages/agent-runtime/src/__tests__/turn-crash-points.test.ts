import { afterEach, expect, it } from 'vitest';
import { turnFixture } from './turn-fixture.js';

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
  f.database.exec(
    "DROP TABLE agent_steps_frames; DROP TABLE agent_steps_terminal; DROP INDEX agent_steps_unresolved; DROP TABLE agent_steps_affinity; DROP TABLE agent_steps_approvals; DROP TABLE agent_steps_effects; DROP TABLE agent_steps_meta; CREATE TABLE agent_steps_meta(id INTEGER PRIMARY KEY CHECK(id=1), writer_format TEXT NOT NULL CHECK(writer_format='agent-steps/1')) STRICT; INSERT INTO agent_steps_meta VALUES(1,'agent-steps/1');",
  );
  await f.crash.reopen();
  expect(
    f.database.prepare('SELECT record FROM agent_steps_turns').get()?.record,
  ).toBe(before);
  expect(
    f.database.prepare('SELECT writer_format FROM agent_steps_meta').get()
      ?.writer_format,
  ).toBe('agent-steps/6');
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
  f.database.exec(
    "DROP TABLE agent_steps_meta; CREATE TABLE agent_steps_meta(id INTEGER PRIMARY KEY CHECK(id=1), writer_format TEXT NOT NULL CHECK(writer_format='agent-steps/5')) STRICT; INSERT INTO agent_steps_meta VALUES(1,'agent-steps/5');",
  );
  await f.crash.reopen();
  expect(
    f.database.prepare('SELECT record FROM agent_steps_turns').get()?.record,
  ).toBe(before);
  expect(
    f.database.prepare('SELECT writer_format FROM agent_steps_meta').get()
      ?.writer_format,
  ).toBe('agent-steps/6');
});
