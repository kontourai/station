import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type AgentJournal,
  type AgentTurnLease,
  createAgentRuntime,
  openSqliteAgentJournal,
} from '@kontourai/agent-runtime';
import {
  type OwnerIdentity,
  ownerLivenessFromProbe,
} from '@kontourai/monument';
import {
  exactProcessIdentity,
  probeExactProcessIdentity,
} from '@kontourai/station-shared/process-identity';
import type { DurableTurnHandoff } from '../../services/orchestration/interrupted-turn-recovery.js';

type RuntimeOwner = ReturnType<typeof createAgentRuntime>;
type Resume = (lease: AgentTurnLease) => Promise<void>;

/** Claims the journal fence before scheduling any recovered foreground work. */
export function createDurableRecoveryHandoff(options: {
  readonly runtime: RuntimeOwner;
  readonly ready: () => boolean;
  readonly resume: Resume;
  readonly failed: (error: unknown) => void;
}): DurableTurnHandoff {
  const running = new Map<string, Promise<void>>();
  return async ({ record, turnId, signal }) => {
    if (signal.aborted) return 'retry';
    const key = {
      scopeId: 'station',
      conversationId: record.threadId,
      invocationId: turnId,
    };
    const id = JSON.stringify(key);
    if (running.has(id)) return 'claimed';
    const lease = await options.runtime.recover(key, options.ready);
    if (lease === 'not-owned' || lease === 'retry') return lease;
    if (signal.aborted) return 'retry';
    if (running.has(id)) return 'claimed';
    const work = lease.run(() => options.resume(lease));
    running.set(id, work);
    void work.catch(options.failed).finally(() => running.delete(id));
    return 'claimed';
  };
}

const owners = new Map<string, ReturnType<typeof createStationOwner>>();
function createStationOwner(home: string) {
  const path = join(home, 'data', 'agent-runtime.sqlite');
  const identity = exactProcessIdentity(process.pid);
  const owner: OwnerIdentity = identity
    ? {
        id: randomUUID(),
        pid: process.pid,
        identityKind: 'exact',
        birth: identity.start,
      }
    : { id: randomUUID(), pid: process.pid, identityKind: 'unverified' };
  const liveness = ownerLivenessFromProbe(probeExactProcessIdentity);
  // Each command owns its handle. No connection survives a runtime shutdown or
  // home replacement; the journal's SQLite transaction remains the authority.
  const journal: AgentJournal = {
    async execute(command, context) {
      mkdirSync(join(home, 'data'), { recursive: true, mode: 0o700 });
      const database = new DatabaseSync(path);
      try {
        database.exec(
          'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;',
        );
        return await openSqliteAgentJournal({ database }).execute(
          command,
          context,
        );
      } finally {
        database.close();
      }
    },
    async close() {},
  };
  const runtime = createAgentRuntime({
    journal,
    owner,
    liveness,
    implementation: 'station-agent/1',
  });
  let resume: Resume | undefined;
  let failed: (error: unknown) => void = () => {};
  const handoff = createDurableRecoveryHandoff({
    runtime,
    ready: () => resume !== undefined,
    resume: (lease) => {
      if (!resume)
        throw new Error('Durable Station agent recovery is unavailable');
      return resume(lease);
    },
    failed: (error) => failed(error),
  });
  return {
    runtime,
    journal,
    registerRecovery(execute: Resume, reportFailure: (error: unknown) => void) {
      resume = execute;
      failed = reportFailure;
    },
    recover: ((input) =>
      existsSync(path)
        ? handoff(input)
        : Promise.resolve('not-owned')) as DurableTurnHandoff,
  };
}
export function stationAgentRuntimeOwner(home: string) {
  let owner = owners.get(home);
  if (!owner) {
    owner = createStationOwner(home);
    owners.set(home, owner);
  }
  return owner;
}
