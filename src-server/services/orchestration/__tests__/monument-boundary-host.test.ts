import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { KernelCommand, OwnerIdentity } from '@kontourai/monument';
import {
  openSqliteKernelStorage,
  type SqliteKernelDatabase,
  type SqliteKernelStorage,
} from '@kontourai/monument/sqlite';
import {
  KernelCrashError,
  type KernelStorageLocation,
  openCrashPointStore,
} from '@kontourai/monument/testing';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

import type { EventStore } from '../event-store.js';
import type {
  SessionTurnBoundaryCoordinator,
  SessionTurnBoundaryRecord,
} from '../session-turn-boundary.js';
import { createSqliteSessionTurnBoundaryCoordinator } from '../sqlite-session-turn-boundary.js';
import { legacyTurnBoundaryCoordinator } from './fixtures/legacy-turn-boundary.js';
import {
  at,
  context,
  open as openStore,
  owner,
  tables,
} from './fixtures/monument-boundary.js';

const captured: { current?: SessionTurnBoundaryCoordinator } = {};
function open(path: string) {
  const store = openStore(path);
  captured.current = legacyTurnBoundaryCoordinator(store['db'], () => {});
  return store;
}
const metrics = vi.hoisted(() => ({ count: vi.fn(), duration: vi.fn() }));
vi.mock('../../../telemetry/metrics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../telemetry/metrics.js')>()),
  orchestrationEventsPersisted: { add: metrics.count },
  orchestrationEventPersistDuration: { record: metrics.duration },
}));
const makeTempDir = trackTempDirs();
const closes: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  metrics.count.mockReset();
  metrics.duration.mockReset();
});
function record(command: {
  boundaryId: string;
  threadId: string;
  now: string;
  owner: OwnerIdentity;
}): Omit<SessionTurnBoundaryRecord, 'state'> {
  return {
    boundaryId: command.boundaryId,
    threadId: command.threadId,
    ownerId: command.owner.id,
    ownerPid: command.owner.pid,
    ownerIdentityKind: command.owner.identityKind,
    ...(command.owner.identityKind === 'exact'
      ? { ownerBirth: command.owner.birth }
      : {}),
    createdAt: command.now,
    updatedAt: command.now,
  };
}
type BoundaryCommand = Extract<
  KernelCommand,
  { type: `turnBoundary.${string}` }
>;
function legacy(
  coordinator: SessionTurnBoundaryCoordinator,
  command: BoundaryCommand,
) {
  switch (command.type) {
    case 'turnBoundary.create':
      return coordinator.create({
        ...record(command),
        state: command.state,
        ...(command.purpose === 'task-dispatch'
          ? { purpose: 'task-dispatch' as const }
          : {}),
      });
    case 'turnBoundary.recordAccepted':
      return coordinator.recordAccepted({
        ...record(command),
        state: 'accepted',
        providerTurnId: command.providerTurnId,
      });
    case 'turnBoundary.transition':
      return coordinator.transition({ ...command, from: [...command.from] });
    case 'turnBoundary.remove':
      return coordinator.remove({ ...command, from: [...command.from] });
    case 'turnBoundary.observeTerminal':
      return coordinator.removeTerminal({
        ...command,
        terminalCreatedAt: command.terminalCreatedAt,
      });
    case 'turnBoundary.list':
      return {
        kind: 'records',
        records: coordinator.active().map((row) => ({
          boundaryId: row.boundaryId,
          threadId: row.threadId,
          state: row.state,
          purpose: row.purpose ?? 'turn',
          ...(row.providerTurnId ? { providerTurnId: row.providerTurnId } : {}),
          owner: {
            id: row.ownerId,
            pid: row.ownerPid,
            identityKind: row.ownerIdentityKind,
            ...(row.ownerBirth ? { birth: row.ownerBirth } : {}),
          },
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
      };
    default:
      throw new Error(`Not an oracle operation: ${command.type}`);
  }
}
function rows(db: SqliteKernelDatabase) {
  return db
    .prepare('SELECT * FROM orchestration_turn_boundaries ORDER BY boundary_id')
    .all();
}
function random(seed: number) {
  let n = seed + 1;
  return (max: number) => {
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
    return (n >>> 8) % max;
  };
}

function terminalCommand(
  event: CanonicalRuntimeEvent,
): Extract<BoundaryCommand, { type: 'turnBoundary.observeTerminal' }> {
  const turn = 'turnId' in event ? event.turnId : undefined;
  return {
    type: 'turnBoundary.observeTerminal',
    threadId: event.threadId,
    providerTurnId: turn,
    sessionTerminal: !turn,
    terminalCreatedAt: event.createdAt,
    terminalEventId: event.eventId,
    ...(event.method === 'runtime.error' &&
    event.code === 'SESSION_START_INDETERMINATE'
      ? { retire: false }
      : {}),
  };
}

// Bounded generated histories, not a throughput test: one worker and two small databases.
test.each(Array.from({ length: 400 }, (_, i) => i))(
  'existing Station SQL and the bound kernel agree over generated history %i, including failed and lost commits',
  async (seed) => {
    const root = makeTempDir('monument-boundary-differential-');
    let old = open(join(root, 'old.sqlite'));
    closes.push(() => {
      old.close();
    });
    let coordinator = captured.current;
    if (!coordinator)
      throw new Error('EventStore did not compose its boundary coordinator');
    let current: EventStore;
    let kernel: SqliteKernelStorage;
    const location: KernelStorageLocation = {
      async open(options = {}) {
        current = open(join(root, 'new.sqlite'));
        kernel = openSqliteKernelStorage({
          database: current['db'],
          tables,
          participants: options.participants,
        });
        return {
          execute: (command, ctx) => kernel.execute(command, ctx),
          close: async () => {
            await kernel.close();
            current.close();
          },
        };
      },
      async dispose() {},
    };
    const crash = await openCrashPointStore(location);
    closes.push(() => crash.dispose());
    const pick = random(seed);
    const persisted: CanonicalRuntimeEvent[] = [];
    let ordinal = 0;
    for (let step = 0; step < 64; step++) {
      const threadId = step < 11 ? 't0' : `t${pick(4)}`;
      const boundaryId = `b${ordinal++}`;
      const now = at(pick(60));
      const providerTurnId = `p${pick(5)}`;
      const existing = old['db']
        .prepare(
          'SELECT boundary_id AS id FROM orchestration_turn_boundaries ORDER BY boundary_id',
        )
        .all() as Array<{ id: string }>;
      const id = existing.length
        ? existing[pick(existing.length)].id
        : 'absent';
      let command: BoundaryCommand;
      // Claim after a persisted terminal, replay at equality, advance the head,
      // replace the claim, then replay that same terminal below the new fence.
      switch (step < 11 ? [4, 0, 4, 2, 4, 0, 4, 4, 4, 4, 4][step] : pick(6)) {
        case 0:
          command = {
            type: 'turnBoundary.create',
            boundaryId,
            threadId,
            state: step < 7 || pick(5) ? 'prepared' : 'lifecycle',
            purpose: step < 7 || pick(7) ? 'turn' : 'task-dispatch',
            owner,
            now,
          };
          break;
        case 1: {
          const from = pick(2) ? 'prepared' : 'invoking';
          command = {
            type: 'turnBoundary.transition',
            boundaryId: id,
            ownerId: pick(5) ? owner.id : 'other',
            from: [from],
            to: pick(2)
              ? 'indeterminate'
              : from === 'prepared'
                ? 'invoking'
                : 'accepted',
            providerTurnId,
            now,
          };
          break;
        }
        case 2:
          command = {
            type: 'turnBoundary.remove',
            boundaryId: id,
            ownerId: step === 3 || pick(5) ? owner.id : 'other',
            from:
              step === 3
                ? ['prepared']
                : [
                    (
                      [
                        'prepared',
                        'invoking',
                        'accepted',
                        'indeterminate',
                        'lifecycle',
                      ] as const
                    )[pick(5)],
                  ],
          };
          break;
        case 3:
          command = {
            type: 'turnBoundary.recordAccepted',
            boundaryId,
            threadId,
            providerTurnId,
            owner,
            now,
          };
          break;
        case 4: {
          const method =
            step < 7
              ? 2
              : step === 7 || step === 10
                ? 3
                : step === 8
                  ? 1
                  : step === 9
                    ? 0
                    : pick(4);
          const eventId = `event-${step}`;
          const fresh: CanonicalRuntimeEvent =
            method === 2
              ? {
                  eventId,
                  provider: 'claude',
                  threadId,
                  createdAt: now,
                  method: 'session.exited',
                  sessionId: threadId,
                  exitCode: 0,
                }
              : method === 3
                ? {
                    eventId,
                    provider: 'claude',
                    threadId,
                    createdAt: now,
                    method: 'runtime.error',
                    severity: 'error',
                    message: 'generated terminal',
                    code:
                      step === 7 || (step >= 11 && pick(2))
                        ? 'SESSION_START_INDETERMINATE'
                        : 'PROVIDER_FAILED',
                  }
                : method === 0
                  ? {
                      eventId,
                      provider: 'claude',
                      threadId,
                      turnId: providerTurnId,
                      createdAt: now,
                      method: 'turn.completed',
                    }
                  : {
                      eventId,
                      provider: 'claude',
                      threadId,
                      turnId: providerTurnId,
                      createdAt: now,
                      method: 'turn.aborted',
                      reason: 'generated abort',
                    };
          const replay =
            step === 2 ||
            step === 6 ||
            (step >= 11 && persisted.length > 0 && pick(3) === 0);
          const event = replay
            ? persisted[step < 7 ? 0 : pick(persisted.length)]
            : fresh;
          if (!replay && (step < 11 || pick(4) !== 0)) {
            old.appendEvent(event);
            current!.appendEvent(event);
            persisted.push(event);
          }
          command = terminalCommand(event);
          break;
        }
        default:
          command = { type: 'turnBoundary.list' };
      }
      // The old side stays at the committed prefix while the new side loses a command.
      // Retry applies it exactly once, then both observable answers and durable rows agree.
      if (step % 19 === 0 && command.type !== 'turnBoundary.list') {
        crash.failNextCommit(new Error('injected boundary commit'));
        const before = rows(current!['db']);
        await expect(crash.storage.execute(command, context())).rejects.toThrow(
          'injected boundary commit',
        );
        expect(rows(current!['db'])).toEqual(before);
        await crash.reopen();
        old.close();
        old = open(join(root, 'old.sqlite'));
        coordinator = captured.current;
        if (!coordinator)
          throw new Error('Expected restarted reference coordinator');
      }
      if (step % 23 === 0) {
        const held = crash.holdNextCommit();
        const lost = expect(
          crash.storage.execute(command, context()),
        ).rejects.toBeInstanceOf(KernelCrashError);
        await held.entered;
        await crash.crash();
        await lost;
        await crash.reopen();
        old.close();
        old = open(join(root, 'old.sqlite'));
        coordinator = captured.current;
        if (!coordinator)
          throw new Error('Expected restarted reference coordinator');
      }
      const answer = await crash.storage.execute(command, context());
      const observable =
        answer.kind === 'records'
          ? {
              ...answer,
              records: answer.records.map(
                ({ createdSequence: _fence, ...row }) => row,
              ),
            }
          : answer;
      expect(observable, JSON.stringify({ seed, step, command })).toEqual(
        command.type === 'turnBoundary.observeTerminal' &&
          command.retire === false
          ? { kind: 'applied' }
          : legacy(coordinator, command),
      );
      expect(rows(current!['db'])).toEqual(rows(old['db']));
    }
  },
);

test('a backward transition out of accepted violates the host constraint without changing either database', async () => {
  const root = makeTempDir('monument-invalid-boundary-transition-');
  const old = open(join(root, 'old.sqlite'));
  closes.push(() => {
    old.close();
  });
  const coordinator = captured.current;
  if (!coordinator) throw new Error('Expected production SQL coordinator');
  const current = open(join(root, 'new.sqlite'));
  closes.push(() => {
    current.close();
  });
  const kernel = openSqliteKernelStorage({ database: current['db'], tables });
  const ctx = context();
  const setup: BoundaryCommand[] = [
    {
      type: 'turnBoundary.create',
      boundaryId: 'pending',
      threadId: 'thread',
      state: 'prepared',
      purpose: 'turn',
      owner,
      now: at(0),
    },
    {
      type: 'turnBoundary.recordAccepted',
      boundaryId: 'accepted',
      threadId: 'thread',
      providerTurnId: 'turn',
      owner,
      now: at(1),
    },
  ];
  for (const command of setup)
    expect(await kernel.execute(command, ctx)).toEqual(
      legacy(coordinator, command),
    );
  const before = rows(current['db']);
  const invalid: BoundaryCommand = {
    type: 'turnBoundary.transition',
    boundaryId: 'accepted',
    ownerId: owner.id,
    from: ['accepted'],
    to: 'invoking',
    now: at(2),
  };
  await expect(kernel.execute(invalid, ctx)).rejects.toThrow(
    'UNIQUE constraint failed',
  );
  expect(legacy(coordinator, invalid)).toEqual({ kind: 'unavailable' });
  expect(rows(current['db'])).toEqual(before);
  expect(rows(old['db'])).toEqual(before);
});

test('alternating frozen SQL and the production Monument coordinator share one database for 400 turns', async () => {
  const root = makeTempDir('monument-mixed-boundaries-');
  const reference = open(join(root, 'reference.sqlite'));
  closes.push(() => {
    reference.close();
  });
  const referenceCoordinator = captured.current;
  const shared = open(join(root, 'shared.sqlite'));
  closes.push(() => {
    shared.close();
  });
  const oldWriter = captured.current;
  if (!referenceCoordinator || !oldWriter)
    throw new Error('Expected production SQL coordinators');
  const peer = new DatabaseSync(join(root, 'shared.sqlite'));
  closes.push(() => peer.close());
  const migratedWriter = createSqliteSessionTurnBoundaryCoordinator({
    db: peer,
    head: () =>
      Number(
        (
          peer
            .prepare(
              'SELECT high_water FROM orchestration_stream_identity WHERE singleton = 1',
            )
            .get() as { high_water: number }
        ).high_water,
      ),
    reconcileTerminals: () => {},
    retiredBoundaryIds: () => [],
    transactionLost: (cause) => new Error('Host transaction lost', { cause }),
  });
  let ordinal = 0;
  const compare = async (command: BoundaryCommand) => {
    const answer =
      ordinal++ % 2 === 0
        ? legacy(oldWriter, command)
        : legacy(migratedWriter, command);
    expect(answer).toEqual(legacy(referenceCoordinator, command));
    expect(rows(peer)).toEqual(rows(reference['db']));
  };
  for (let i = 0; i < 400; i++) {
    const boundaryId = `b${i}`;
    const threadId = `t${i % 4}`;
    const turn = `p${i % 7}`;
    await compare({
      type: 'turnBoundary.create',
      boundaryId,
      threadId,
      state: 'prepared',
      purpose: 'turn',
      owner,
      now: at(i * 3),
    });
    await compare({
      type: 'turnBoundary.transition',
      boundaryId,
      ownerId: owner.id,
      from: ['prepared'],
      to: 'invoking',
      now: at(i * 3 + 1),
    });
    await compare({
      type: 'turnBoundary.transition',
      boundaryId,
      ownerId: owner.id,
      from: ['invoking'],
      to: 'accepted',
      providerTurnId: turn,
      now: at(i * 3 + 2),
    });
    const sessionTerminal = i % 3 === 0;
    const event: CanonicalRuntimeEvent = sessionTerminal
      ? {
          eventId: `terminal-${i}`,
          provider: 'claude',
          threadId,
          createdAt: at(i * 3 - 30),
          method: 'session.exited',
          sessionId: threadId,
          exitCode: 0,
        }
      : {
          eventId: `terminal-${i}`,
          provider: 'claude',
          threadId,
          turnId: turn,
          createdAt: at(i * 3 + 3),
          method: 'turn.completed',
        };
    reference.appendEvent(event);
    shared.appendEvent(event);
    await compare({
      type: 'turnBoundary.observeTerminal',
      threadId,
      providerTurnId: sessionTerminal ? undefined : turn,
      sessionTerminal,
      terminalCreatedAt: event.createdAt,
      terminalEventId: event.eventId,
    });
    await compare({
      type: 'turnBoundary.remove',
      boundaryId,
      ownerId: owner.id,
      from: ['prepared', 'invoking', 'accepted', 'indeterminate'],
    });
  }
});
