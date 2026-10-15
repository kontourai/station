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
import {
  at,
  context,
  open,
  owner,
  tables,
} from './fixtures/monument-boundary.js';

// Observe the coordinator EventStore really composes; its SQL remains the oracle.
const captured: { current?: SessionTurnBoundaryCoordinator } = vi.hoisted(
  () => ({}),
);
vi.mock('../session-turn-boundary.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../session-turn-boundary.js')>();
  return {
    ...actual,
    createSessionTurnBoundaryAuthority(
      options: Parameters<typeof actual.createSessionTurnBoundaryAuthority>[0],
    ) {
      captured.current = options.coordinator;
      return actual.createSessionTurnBoundaryAuthority(options);
    },
  };
});
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
    return n % max;
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
    let ordinal = 0;
    for (let step = 0; step < 64; step++) {
      const threadId = `t${pick(4)}`;
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
      switch (pick(6)) {
        case 0:
          command = {
            type: 'turnBoundary.create',
            boundaryId,
            threadId,
            state: pick(5) ? 'prepared' : 'lifecycle',
            purpose: pick(7) ? 'turn' : 'task-dispatch',
            owner,
            now,
          };
          break;
        case 1:
          command = {
            type: 'turnBoundary.transition',
            boundaryId: id,
            ownerId: pick(5) ? owner.id : 'other',
            from: [
              (['prepared', 'invoking', 'accepted', 'indeterminate'] as const)[
                pick(4)
              ],
            ],
            to: (['invoking', 'accepted', 'indeterminate'] as const)[pick(3)],
            providerTurnId,
            now,
          };
          break;
        case 2:
          command = {
            type: 'turnBoundary.remove',
            boundaryId: id,
            ownerId: pick(5) ? owner.id : 'other',
            from: [
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
          const sessionTerminal = pick(2) === 0;
          const eventId = `event-${step}`;
          const event: CanonicalRuntimeEvent = sessionTerminal
            ? {
                eventId,
                provider: 'claude',
                threadId,
                createdAt: now,
                method: 'session.exited',
                sessionId: threadId,
                exitCode: 0,
              }
            : {
                eventId,
                provider: 'claude',
                threadId,
                turnId: providerTurnId,
                createdAt: now,
                method: 'turn.completed',
              };
          if (pick(4) !== 0) {
            old.appendEvent(event);
            current!.appendEvent(event);
          }
          command = {
            type: 'turnBoundary.observeTerminal',
            threadId,
            providerTurnId: sessionTerminal ? undefined : providerTurnId,
            sessionTerminal,
            terminalCreatedAt: now,
            terminalEventId: eventId,
          };
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
        await expect(
          crash.storage.execute(command, context(current!['db'])),
        ).rejects.toThrow('injected boundary commit');
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
          crash.storage.execute(command, context(current!['db'])),
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
      const answer = await crash.storage.execute(
        command,
        context(current!['db']),
      );
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
        legacy(coordinator, command),
      );
      expect(rows(current!['db'])).toEqual(rows(old['db']));
    }
  },
);

test('alternating old SQL and new kernel writers share one database for 400 turns', async () => {
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
  const kernel = openSqliteKernelStorage({ database: peer, tables });
  let ordinal = 0;
  const compare = async (command: BoundaryCommand) => {
    const answer =
      ordinal++ % 2 === 0
        ? legacy(oldWriter, command)
        : await kernel.execute(command, context(peer));
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
    const event: CanonicalRuntimeEvent = {
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
      providerTurnId: turn,
      sessionTerminal: false,
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
