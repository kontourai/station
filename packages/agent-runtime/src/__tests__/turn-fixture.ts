import { mkdtempDisposableSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openAtomicCrashPointStore } from '@kontourai/monument/testing';
import {
  type AgentJournalContext,
  type AgentJournalProtocol,
  type AgentTurnLease,
  createAgentRuntime,
  openSqliteAgentJournal,
} from '../index.js';
import { key, nextOwner, owner } from './fixture.js';

export function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
export async function turnFixture() {
  const directory = mkdtempDisposableSync(join(tmpdir(), 'agent-turn-'));
  const database = new DatabaseSync(join(directory.path, 'agent.sqlite'));
  database.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;',
  );
  const crash = await openAtomicCrashPointStore<
    AgentJournalProtocol,
    AgentJournalContext,
    DatabaseSync
  >({
    async open(options) {
      return openSqliteAgentJournal({
        database,
        participants: options?.participants,
      });
    },
    async dispose() {},
  });
  let dead = false;
  let now = 1_000;
  const liveness = (candidate: { id: string }) =>
    dead && candidate.id === owner.id ? ('dead' as const) : ('live' as const);
  const runtime = createAgentRuntime({
    journal: crash.storage,
    owner,
    liveness,
    implementation: 'station-agent/1',
    now: () => now,
  });
  const lease = await runtime.start({
    key,
    input: '{"input":"hello"}',
    implementation: 'station-agent/1',
  });
  const successor = createAgentRuntime({
    journal: crash.storage,
    owner: nextOwner,
    liveness,
    now: () => now,
    implementation: 'station-agent/1',
  });
  return {
    key,
    database,
    crash,
    lease,
    liveness,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    async recover(): Promise<AgentTurnLease> {
      dead = true;
      await crash.reopen();
      const result = await successor.recover(key);
      if (typeof result === 'string')
        throw Error(`Real recovery prerequisite: ${result}`);
      return result;
    },
    async close() {
      await crash.dispose();
      database.close();
      directory.remove();
    },
  };
}
