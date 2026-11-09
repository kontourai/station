import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { STATION_HOME_ROOTS } from '../../packages/shared/src/station-home-store-registry.js';
import {
  DEV_HOME_SEED_MARKER,
  DROP_CATEGORIES,
  ORCHESTRATION_KEEP_TABLES,
  ROOT_DECISIONS,
  seedDevHome,
} from '../seed-dev-home.mjs';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'seed-dev-home-'));
  roots.push(dir);
  return dir;
}

function write(home: string, path: string, content: string) {
  mkdirSync(dirname(join(home, path)), { recursive: true });
  writeFileSync(join(home, path), content);
}

function sqlite(path: string, sql: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF');
  db.exec(sql);
  return db;
}

function treeDigest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      // Any SQLite reader, read-only included, updates the -shm
      // shared-memory index; it holds no data, so it is not compared.
      if (entry.name.endsWith('-shm')) continue;
      if (entry.isSymbolicLink()) out[relative(dir, full)] = 'link';
      else if (entry.isDirectory()) walk(full);
      else {
        out[relative(dir, full)] = createHash('sha256')
          .update(readFileSync(full))
          .digest('hex');
      }
    }
  };
  walk(dir);
  return out;
}

/** A source home with one representative of every category the seed must drop. */
function buildSourceHome() {
  const base = tempDir();
  const home = join(base, 'source');
  write(home, '.station-home-schema.json', '{"schemaVersion":2}');
  write(home, 'projects/p1/project.json', '{"id":"p1","name":"Real project"}');
  write(home, 'agents/claude/agent.json', '{"name":"Claude"}');
  write(home, 'layouts/personal/x.json', '{}');
  write(home, 'config/app.json', '{"defaultModel":"m"}');
  write(home, 'config/agent-registry.json', '{"version":1}');
  write(home, 'data/attachments/a.txt', 'attachment');

  // Credentials and sign-in state.
  write(
    home,
    'config/providers.json',
    '[{"id":"x","config":{"apiKey":"sk-secret"}}]',
  );
  write(home, 'config/acp.json', '{"connections":[{"env":{"TOKEN":"t"}}]}');
  write(home, 'security/push-signing-key.json', '{"privateKey":"k"}');
  write(home, 'security/paired-devices.json', '[]');
  write(home, 'browser/profiles/default/Cookies', 'cookies');
  write(home, 'app-homes/claude/.credentials.json', '{}');
  sqlite(
    join(home, 'authentication/application-sessions.sqlite'),
    "CREATE TABLE sessions(id TEXT); INSERT INTO sessions VALUES ('s1');",
  ).close();
  write(home, 'runtime/local-grant.secret', 'grant');
  // Scheduled jobs and pending work.
  sqlite(
    join(home, 'scheduler/scheduler.sqlite'),
    "CREATE TABLE jobs(id TEXT); INSERT INTO jobs VALUES ('nightly');",
  ).close();
  sqlite(
    join(home, 'automation/automation.sqlite'),
    "CREATE TABLE rules(id TEXT); INSERT INTO rules VALUES ('r');",
  ).close();
  write(home, 'task-room-work.json', '{"pending":true}');
  write(home, 'data/agent-runtime/steps.sqlite', 'journal');
  // Links to other machines.
  write(home, 'devices/setup.json', '{}');
  write(home, 'environments/ssh.json', '{"hosts":["build-box"]}');
  write(home, 'integrations/station-control/x.json', '{}');
  // Code that runs, and telemetry that reports as the developer.
  write(home, 'plugins/p/index.js', 'run()');
  write(home, 'plugin-grants.json', '{}');
  write(home, 'config/telemetry-outbox.json', '[{"event":"x"}]');
  // A root no one has classified yet.
  write(home, 'brand-new-store.json', '{"future":true}');
  // A link out of the home must never be followed.
  const outside = join(base, 'outside');
  write(outside, 'private.txt', 'outside the home');
  symlinkSync(outside, join(home, 'projects/p1/escape'));

  const orchestration = sqlite(
    join(home, 'data/orchestration.sqlite'),
    `
    CREATE TABLE monument_meta(key TEXT, value TEXT);
    INSERT INTO monument_meta VALUES ('schema', '7');
    CREATE TABLE orchestration_events(id INTEGER PRIMARY KEY, thread TEXT, body TEXT);
    INSERT INTO orchestration_events(thread, body) VALUES ('t1', 'hello'), ('t1', 'world');
    CREATE VIRTUAL TABLE orchestration_message_search_v3 USING fts5(body);
    INSERT INTO orchestration_message_search_v3 VALUES ('hello world');
    CREATE TABLE orchestration_recovery_intents(id TEXT);
    INSERT INTO orchestration_recovery_intents VALUES ('resume-t1');
    CREATE TABLE coordinator_wakes(id TEXT);
    INSERT INTO coordinator_wakes VALUES ('wake');
    CREATE TABLE orchestration_prepared_turns(id TEXT);
    INSERT INTO orchestration_prepared_turns VALUES ('turn');
    CREATE TABLE orchestration_native_session_bindings(id TEXT);
    INSERT INTO orchestration_native_session_bindings VALUES ('claude-session');
    CREATE TABLE some_future_queue(id TEXT);
    INSERT INTO some_future_queue VALUES ('job');
    CREATE VIRTUAL TABLE future_search USING fts5(body);
    INSERT INTO future_search VALUES ('pending search');
    CREATE TABLE orchestration_turn_dedup(id TEXT);
    INSERT INTO orchestration_turn_dedup VALUES ('d');
    CREATE TRIGGER dedup_delete_guard BEFORE DELETE ON orchestration_turn_dedup
      BEGIN SELECT RAISE(ABORT, 'deletion requires a permit'); END;
  `,
  );
  // Leave rows in the WAL, as a running Station would.
  orchestration.exec(
    "INSERT INTO orchestration_events(thread, body) VALUES ('t2', 'in wal')",
  );
  return { home, base, orchestration };
}

describe('seedDevHome', () => {
  it('gives every known Station home root a deliberate decision', () => {
    const missing = Object.keys(STATION_HOME_ROOTS).filter(
      (root) => !(root in ROOT_DECISIONS),
    );
    expect(missing).toEqual([]);
    for (const decision of Object.values(ROOT_DECISIONS)) {
      expect(decision === 'keep' || decision in DROP_CATEGORIES).toBe(true);
    }
  });

  it('carries history and drops each sensitive category without touching the source', () => {
    const { home, base, orchestration } = buildSourceHome();
    const before = treeDigest(home);
    const target = join(base, 'dev-home');

    const marker = seedDevHome({ source: home, target });
    expect(treeDigest(home)).toEqual(before);
    orchestration.close();

    // Kept.
    for (const path of [
      '.station-home-schema.json',
      'projects/p1/project.json',
      'agents/claude/agent.json',
      'layouts/personal/x.json',
      'config/app.json',
      'config/agent-registry.json',
      'data/attachments/a.txt',
    ]) {
      expect(existsSync(join(target, path)), path).toBe(true);
    }
    // Dropped, by category.
    for (const path of [
      'config/providers.json',
      'config/acp.json',
      'security',
      'browser',
      'app-homes',
      'authentication',
      'runtime',
      'scheduler',
      'automation',
      'task-room-work.json',
      'data/agent-runtime',
      'devices',
      'environments',
      'integrations',
      'plugins',
      'plugin-grants.json',
      'config/telemetry-outbox.json',
      'brand-new-store.json',
      'projects/p1/escape',
    ]) {
      expect(existsSync(join(target, path)), path).toBe(false);
    }
    expect(JSON.stringify(treeDigest(target))).not.toContain('outside');
    expect(marker.dropped.credentials).toEqual(
      expect.arrayContaining([
        'security',
        'authentication',
        'config/providers.json',
      ]),
    );
    expect(marker.dropped['pending-work']).toEqual(
      expect.arrayContaining([
        'scheduler',
        'automation',
        'task-room-work.json',
      ]),
    );
    expect(marker.dropped['other-machines']).toEqual(
      expect.arrayContaining(['devices', 'environments', 'integrations']),
    );
    expect(marker.dropped.telemetry).toEqual(['config/telemetry-outbox.json']);
    expect(marker.dropped.unknown).toEqual(['brand-new-store.json']);
    expect(marker.skippedLinks).toEqual(['projects/p1/escape']);
    expect(
      JSON.parse(readFileSync(join(target, DEV_HOME_SEED_MARKER), 'utf8')),
    ).toEqual(marker);

    // Orchestration: history and search kept, pending work emptied.
    const db = new DatabaseSync(join(target, 'data/orchestration.sqlite'), {
      readOnly: true,
    });
    const count = (table: string) =>
      (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number })
        .n;
    expect(count('orchestration_events')).toBe(3);
    expect(count('monument_meta')).toBe(1);
    expect(count('orchestration_message_search_v3')).toBe(1);
    for (const table of [
      'orchestration_recovery_intents',
      'coordinator_wakes',
      'orchestration_prepared_turns',
      'orchestration_native_session_bindings',
      'some_future_queue',
      'future_search',
      'orchestration_turn_dedup',
    ]) {
      expect(ORCHESTRATION_KEEP_TABLES).not.toContain(table);
      expect(count(table), table).toBe(0);
    }
    expect(marker.clearedTables).toEqual(
      expect.arrayContaining([
        'orchestration_recovery_intents',
        'future_search',
      ]),
    );
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all(),
    ).toEqual([{ name: 'dedup_delete_guard' }]);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({
      integrity_check: 'ok',
    });
    db.close();
    expect(existsSync(join(target, 'data/orchestration.sqlite-wal'))).toBe(
      false,
    );
  });

  it('refuses targets it could damage', () => {
    const { home, base, orchestration } = buildSourceHome();
    orchestration.close();
    expect(() =>
      seedDevHome({ source: home, target: join(home, 'nested') }),
    ).toThrow(/outside the source/);
    const foreign = join(base, 'foreign');
    write(foreign, 'keep-me.txt', 'mine');
    expect(() => seedDevHome({ source: home, target: foreign })).toThrow(
      /not empty/,
    );
    expect(() =>
      seedDevHome({ source: home, target: foreign, force: true }),
    ).toThrow(/not made by this seed/);
    expect(readFileSync(join(foreign, 'keep-me.txt'), 'utf8')).toBe('mine');

    const target = join(base, 'dev-home');
    seedDevHome({ source: home, target });
    const first = statSync(join(target, DEV_HOME_SEED_MARKER)).mtimeMs;
    seedDevHome({
      source: home,
      target,
      force: true,
      now: new Date(first + 1000),
    });
    expect(existsSync(join(target, 'projects/p1/project.json'))).toBe(true);
    write(target, 'instances.json', '{}');
    expect(() => seedDevHome({ source: home, target, force: true })).toThrow(
      /instance record/,
    );
    expect(
      readdirSync(base).filter((name) => name.includes('.seeding-')),
    ).toEqual([]);
  });
});
