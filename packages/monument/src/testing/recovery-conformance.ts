import assert from 'node:assert/strict';
import type { RecoveryIntentInput } from '../recovery-ledger.js';
import type {
  RecoverySqlIntent,
  RecoveryStorageCommand,
  RecoveryStoragePort,
} from '../sqlite-recovery.js';
import type { KernelConformanceRunner } from './conformance.js';

/** The test record is deliberately independent of any host contract package. */
export type RecoveryConformanceIntent = RecoverySqlIntent;
export type RecoveryConformanceStorage = RecoveryStoragePort<
  RecoveryConformanceIntent,
  RecoveryConformanceIntent,
  string
>;
export interface RecoveryConformanceSession {
  readonly storage: RecoveryConformanceStorage;
  reopen(): Promise<void>;
  markSourceTerminated(threadId: string, turnId: string): void;
  failNextCommit(): void;
  loseNextAcknowledgement(): void;
  onNextCommit(callback: () => void): void;
  dispose(): Promise<void>;
}
export interface RecoveryConformanceHarness {
  readonly name: string;
  create(): Promise<RecoveryConformanceSession>;
}
export interface RecoveryConformanceCase {
  readonly name: string;
  run(harness: RecoveryConformanceHarness): Promise<void>;
}

const at = '2026-08-13T00:00:00.000Z';
const later = '2026-08-13T00:00:01.000Z';
const owner = {
  id: 'owner',
  pid: 123,
  birth: 'birth',
  identityKind: 'exact',
} as const;
const intent = (fingerprint: string) =>
  ({
    fingerprint,
    threadId: `thread-${fingerprint}`,
    provider: 'engine',
    sourceEventId: `event-${fingerprint}`,
    sourceTurnId: 'turn',
    failureKind: 'capacity',
    scope: 'account',
    decision: 'retry-now',
    dueAt: at,
    maxAttempts: 1,
    outcome: 'armed',
    createdAt: at,
    updatedAt: at,
  }) as const;
const claim = (fingerprint: string, kind: 'due' | 'profile' = 'due') => ({
  fingerprint,
  kind,
  dispatchAttemptId: `attempt-${fingerprint}`,
  recoveryCorrelationId: `correlation-${fingerprint}`,
  owner,
  now: at,
});
async function withSession(
  harness: RecoveryConformanceHarness,
  body: (session: RecoveryConformanceSession) => Promise<void>,
) {
  const session = await harness.create();
  try {
    await body(session);
  } finally {
    await session.dispose();
  }
}

const basicRecoveryConformanceCases: readonly RecoveryConformanceCase[] = [
  {
    name: 'does not alias input or returned records',
    run: (harness) =>
      withSession(harness, async ({ storage }) => {
        const input: RecoveryIntentInput<RecoveryConformanceIntent> = {
          ...intent('alias'),
        };
        const first = await storage.execute({
          type: 'armRecoveryIntent',
          args: [input],
        });
        input.provider = 'changed';
        first.provider = 'changed-again';
        assert.equal(
          (
            await storage.execute({
              type: 'findRecoveryIntent',
              args: ['alias'],
            })
          )?.provider,
          'engine',
        );
      }),
  },
  {
    name: 'retains owner identity and treats empty durable tokens as present',
    run: (harness) =>
      withSession(harness, async ({ storage }) => {
        await storage.execute({
          type: 'armRecoveryIntent',
          args: [intent('identity')],
        });
        const suppliedOwner: {
          id: string;
          pid: number;
          birth: string;
          identityKind: 'exact';
        } = { ...owner };
        await storage.execute({
          type: 'claimRecoveryDispatch',
          args: [
            {
              ...claim('identity'),
              owner: suppliedOwner,
              dispatchAttemptId: '',
              recoveryCorrelationId: '',
            },
          ],
        });
        suppliedOwner.birth = 'changed';
        assert.equal(
          await storage.execute({
            type: 'claimRecoveryDispatch',
            args: [claim('identity')],
          }),
          null,
        );
        const prepared = await storage.execute({
          type: 'preparedRecoveryDispatches',
          args: ['due'],
        });
        assert.equal(prepared.length, 1);
        assert.equal(prepared[0]?.ownerBirth, 'birth');
      }),
  },
  {
    name: 'keeps raw empty values distinct from absent values in durable decisions',
    run: (harness) =>
      withSession(harness, async ({ storage }) => {
        await storage.execute({
          type: 'armRecoveryIntent',
          args: [{ ...intent('empty-due'), dueAt: '' }],
        });
        assert.equal(
          (
            await storage.execute({
              type: 'findRecoveryIntent',
              args: ['empty-due'],
            })
          )?.dueAt,
          undefined,
        );
        assert.equal(
          (
            await storage.execute({
              type: 'claimRecoveryDispatch',
              args: [claim('empty-due')],
            })
          )?.outcome,
          'resumed',
        );
        await storage.execute({
          type: 'observeRecoveryDispatchCorrelation',
          args: ['correlation-empty-due', '', at],
        });
        const repeated = await storage.execute({
          type: 'observeRecoveryDispatchCorrelation',
          args: ['correlation-empty-due', 'new-turn', later],
        });
        assert.equal(repeated?.resumedTurnId, undefined);
      }),
  },
  {
    name: 'arms idempotently, reads projections and survives reopen',
    run: (harness) =>
      withSession(harness, async (session) => {
        const first = await session.storage.execute({
          type: 'armRecoveryIntent',
          args: [intent('one')],
        });
        assert.equal(first.attempts, 0);
        const replay = await session.storage.execute({
          type: 'armRecoveryIntent',
          args: [{ ...intent('one'), provider: 'other' }],
        });
        assert.equal(replay.provider, 'engine');
        assert.equal(
          (
            await session.storage.execute({
              type: 'readRecoveryProjection',
              args: ['thread-one'],
            })
          )?.fingerprint,
          'one',
        );
        assert.deepEqual(
          (
            await session.storage.execute({
              type: 'readPendingRecoveryIntents',
              args: [],
            })
          ).map((row) => row.fingerprint),
          ['one'],
        );
        await session.reopen();
        assert.equal(
          (
            await session.storage.execute({
              type: 'findRecoveryIntent',
              args: ['one'],
            })
          )?.outcome,
          'armed',
        );
      }),
  },
  {
    name: 'fences claims and requires provider acceptance before success',
    run: (harness) =>
      withSession(harness, async ({ storage }) => {
        await storage.execute({
          type: 'armRecoveryIntent',
          args: [intent('one')],
        });
        assert.equal(
          await storage.execute({
            type: 'claimRecoveryDispatch',
            args: [{ ...claim('one'), now: '2026-08-12T23:59:59.000Z' }],
          }),
          null,
        );
        assert.equal(
          (
            await storage.execute({
              type: 'claimRecoveryDispatch',
              args: [claim('one')],
            })
          )?.dispatchSettlement,
          'prepared',
        );
        assert.equal(
          await storage.execute({
            type: 'claimRecoveryDispatch',
            args: [claim('one')],
          }),
          null,
        );
        assert.deepEqual(
          await storage.execute({
            type: 'acceptRecoveryDispatch',
            args: [
              {
                fingerprint: 'one',
                dispatchAttemptId: 'wrong',
                turnId: 'provider',
                now: later,
              },
            ],
          }),
          { kind: 'stale' },
        );
        assert.deepEqual(
          await storage.execute({
            type: 'recordRecoveryTerminal',
            args: ['one', 'succeeded', later],
          }),
          { kind: 'stale' },
        );
        assert.equal(
          (
            await storage.execute({
              type: 'observeRecoveryDispatchCorrelation',
              args: ['correlation-one', 'observed', later],
            })
          )?.resumedTurnId,
          'observed',
        );
        assert.deepEqual(
          await storage.execute({
            type: 'acceptRecoveryDispatch',
            args: [
              {
                fingerprint: 'one',
                dispatchAttemptId: 'attempt-one',
                turnId: 'provider',
                now: later,
              },
            ],
          }),
          { kind: 'applied' },
        );
        assert.equal(
          (await storage.execute({ type: 'findRecoveryIntent', args: ['one'] }))
            ?.resumedTurnId,
          'observed',
        );
        assert.deepEqual(
          await storage.execute({
            type: 'recordRecoveryTerminal',
            args: ['one', 'succeeded', later],
          }),
          { kind: 'applied' },
        );
      }),
  },
  {
    name: 'preserves the existing behavior for duplicate correlation identities',
    run: (harness) =>
      withSession(harness, async ({ storage }) => {
        for (const id of ['first', 'second']) {
          await storage.execute({
            type: 'armRecoveryIntent',
            args: [intent(id)],
          });
          await storage.execute({
            type: 'claimRecoveryDispatch',
            args: [{ ...claim(id), recoveryCorrelationId: 'shared' }],
          });
        }
        await storage.execute({
          type: 'observeRecoveryDispatchCorrelation',
          args: ['shared', 'observed', later],
        });
        for (const id of ['first', 'second'])
          assert.equal(
            (await storage.execute({ type: 'findRecoveryIntent', args: [id] }))
              ?.resumedTurnId,
            'observed',
          );
      }),
  },
  {
    name: 'links exact credential authority and fences only the matching prepared owner',
    run: (harness) =>
      withSession(harness, async ({ storage }) => {
        await storage.execute({
          type: 'armRecoveryIntent',
          args: [intent('profile')],
        });
        await storage.execute({
          type: 'claimRecoveryDispatch',
          args: [claim('profile', 'profile')],
        });
        const linked = {
          fingerprint: 'profile',
          dispatchAttemptId: 'attempt-profile',
          credentialAttemptId: 'credential',
          now: later,
        };
        assert.deepEqual(
          await storage.execute({
            type: 'linkRecoveryCredentialAttempt',
            args: [linked],
          }),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await storage.execute({
            type: 'linkRecoveryCredentialAttempt',
            args: [{ ...linked, credentialAttemptId: 'other' }],
          }),
          { kind: 'stale' },
        );
        const rows = await storage.execute({
          type: 'preparedRecoveryDispatches',
          args: ['profile'],
        });
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.credentialAttemptId, 'credential');
        const fence = {
          fingerprint: 'profile',
          dispatchAttemptId: 'attempt-profile',
          recoveryCorrelationId: 'correlation-profile',
          ownerId: 'owner',
          ownerPid: 123,
          now: later,
        };
        assert.equal(
          await storage.execute({
            type: 'indeterminatePreparedRecoveryDispatch',
            args: [{ ...fence, ownerId: 'other' }],
          }),
          null,
        );
        assert.equal(
          (
            await storage.execute({
              type: 'indeterminatePreparedRecoveryDispatch',
              args: [fence],
            })
          )?.outcome,
          'indeterminate',
        );
        assert.equal(
          await storage.execute({
            type: 'indeterminatePreparedRecoveryDispatch',
            args: [fence],
          }),
          null,
        );
        assert.deepEqual(
          await storage.execute({
            type: 'markRecoveryCompensation',
            args: ['profile', later, 'indeterminate'],
          }),
          { kind: 'applied' },
        );
        assert.equal(
          (
            await storage.execute({
              type: 'readRecoveryCompensationSnapshot',
              args: [],
            })
          ).length,
          1,
        );
        assert.deepEqual(
          await storage.execute({
            type: 'resolveRecoveryCompensationRecord',
            args: ['profile', later],
          }),
          { kind: 'applied' },
        );
      }),
  },
  {
    name: 'releases only the matching prepared attempt and preserves manual decisions',
    run: (harness) =>
      withSession(harness, async ({ storage }) => {
        await storage.execute({
          type: 'armRecoveryIntent',
          args: [{ ...intent('one'), usageLimit: true }],
        });
        await storage.execute({
          type: 'claimRecoveryDispatch',
          args: [claim('one')],
        });
        assert.deepEqual(
          await storage.execute({
            type: 'releaseRecoveryDispatch',
            args: [
              {
                fingerprint: 'one',
                dispatchAttemptId: 'other',
                outcome: 'armed',
                now: later,
              },
            ],
          }),
          { kind: 'stale' },
        );
        assert.deepEqual(
          await storage.execute({
            type: 'releaseRecoveryDispatch',
            args: [
              {
                fingerprint: 'one',
                dispatchAttemptId: 'attempt-one',
                outcome: 'manual',
                now: later,
              },
            ],
          }),
          { kind: 'applied' },
        );
        assert.equal(
          (
            await storage.execute({
              type: 'readUsageLimitIntentsAwaitingUser',
              args: [],
            })
          ).length,
          1,
        );
        assert.deepEqual(
          await storage.execute({
            type: 'retireWaitingRecovery',
            args: [
              {
                fingerprint: 'one',
                outcome: 'canceled',
                reason: 'user-canceled',
                now: later,
              },
            ],
          }),
          { kind: 'applied' },
        );
        assert.equal(
          (await storage.execute({ type: 'findRecoveryIntent', args: ['one'] }))
            ?.outcomeReason,
          'user-canceled',
        );
      }),
  },
  {
    name: 'retains uncertain effects and refuses source-terminal or shutdown recovery',
    run: (harness) =>
      withSession(harness, async (session) => {
        const { storage } = session;
        await storage.execute({
          type: 'armRecoveryIntent',
          args: [intent('ended')],
        });
        session.markSourceTerminated('thread-ended', 'turn');
        assert.equal(
          await storage.execute({
            type: 'claimRecoveryDispatch',
            args: [claim('ended')],
          }),
          null,
        );
        assert.deepEqual(
          await storage.execute({
            type: 'cancelRecoveryIfSourceTerminated',
            args: ['ended', later],
          }),
          { kind: 'applied' },
        );
        await storage.execute({
          type: 'armRecoveryIntent',
          args: [intent('other')],
        });
        await storage.execute({
          type: 'claimRecoveryDispatch',
          args: [claim('other')],
        });
        assert.deepEqual(
          await storage.execute({
            type: 'markRecoveryDispatchIndeterminate',
            args: ['other', 'attempt-other', later],
          }),
          { kind: 'applied' },
        );
        assert.deepEqual(
          await storage.execute({
            type: 'recordRecoveryTerminal',
            args: ['other', 'succeeded', later],
          }),
          { kind: 'stale' },
        );
        await storage.execute({
          type: 'armRecoveryIntent',
          args: [intent('shutdown')],
        });
        assert.deepEqual(
          await storage.execute({
            type: 'cancelShutdownRecoveries',
            args: [later],
          }),
          { kind: 'applied' },
        );
        assert.equal(
          await storage.execute({
            type: 'claimRecoveryDispatch',
            args: [claim('shutdown')],
          }),
          null,
        );
        assert.deepEqual(
          await storage.execute({
            type: 'cancelSourceTerminatedRecoveries',
            args: [later],
          }),
          { kind: 'applied' },
        );
      }),
  },
  {
    name: 'rolls back before commit and preserves a committed command after lost acknowledgement',
    run: (harness) =>
      withSession(harness, async (session) => {
        session.failNextCommit();
        await assert.rejects(
          session.storage.execute({
            type: 'armRecoveryIntent',
            args: [intent('before')],
          }),
          /commit fault/,
        );
        await session.reopen();
        assert.equal(
          await session.storage.execute({
            type: 'findRecoveryIntent',
            args: ['before'],
          }),
          null,
        );
        session.loseNextAcknowledgement();
        await assert.rejects(
          session.storage.execute({
            type: 'armRecoveryIntent',
            args: [intent('after')],
          }),
          /acknowledgement fault/,
        );
        await session.reopen();
        assert.equal(
          (
            await session.storage.execute({
              type: 'findRecoveryIntent',
              args: ['after'],
            })
          )?.outcome,
          'armed',
        );
      }),
  },
  {
    name: 'refuses reentrant access while a participant joins the transaction',
    run: (harness) =>
      withSession(harness, async (session) => {
        session.onNextCommit(() => {
          assert.throws(
            () =>
              session.storage.executeSync({
                type: 'findRecoveryIntent',
                args: ['nested'],
              }),
            /existing transaction/,
          );
        });
        await session.storage.execute({
          type: 'armRecoveryIntent',
          args: [intent('nested')],
        });
        assert.equal(
          (
            await session.storage.execute({
              type: 'findRecoveryIntent',
              args: ['nested'],
            })
          )?.outcome,
          'armed',
        );
      }),
  },
  {
    name: 'retains a waiting usage-limit intent at shutdown and honors an immediate claim',
    run: (harness) =>
      withSession(harness, async ({ storage }) => {
        await storage.execute({
          type: 'armRecoveryIntent',
          args: [
            {
              ...intent('wait'),
              decision: 'wait-until-reset',
              dueAt: later,
              usageLimit: true,
            },
          ],
        });
        assert.deepEqual(
          await storage.execute({
            type: 'cancelShutdownRecoveries',
            args: [at],
          }),
          { kind: 'stale' },
        );
        const held = await storage.execute({
          type: 'findRecoveryIntent',
          args: ['wait'],
        });
        assert.equal(held?.outcome, 'armed');
        assert.equal(
          (
            await storage.execute({
              type: 'claimRecoveryDispatch',
              args: [{ ...claim('wait'), immediate: true }],
            })
          )?.outcome,
          'resumed',
        );
        assert.deepEqual(
          await storage.execute({
            type: 'cancelRecovery',
            args: ['wait', later, 'user-canceled'],
          }),
          { kind: 'applied' },
        );
        assert.equal(
          (
            await storage.execute({
              type: 'findRecoveryIntent',
              args: ['wait'],
            })
          )?.outcomeReason,
          'user-canceled',
        );
      }),
  },
  {
    name: 'treats an empty shutdown marker as a durable fence',
    run: (harness) =>
      withSession(harness, async ({ storage }) => {
        await storage.execute({
          type: 'armRecoveryIntent',
          args: [intent('empty-shutdown')],
        });
        assert.deepEqual(
          await storage.execute({
            type: 'cancelShutdownRecoveries',
            args: [''],
          }),
          { kind: 'applied' },
        );
        assert.equal(
          await storage.execute({
            type: 'claimRecoveryDispatch',
            args: [claim('empty-shutdown')],
          }),
          null,
        );
      }),
  },
];

type ConformanceCommand = RecoveryStorageCommand<
  RecoveryConformanceIntent,
  RecoveryConformanceIntent,
  string
>;
type CrashScenario = {
  readonly name: string;
  prepare(session: RecoveryConformanceSession): Promise<ConformanceCommand>;
};

async function prepared(
  session: RecoveryConformanceSession,
  kind: 'due' | 'profile' = 'due',
): Promise<void> {
  await session.storage.execute({
    type: 'armRecoveryIntent',
    args: [intent('crash')],
  });
  await session.storage.execute({
    type: 'claimRecoveryDispatch',
    args: [claim('crash', kind)],
  });
}

const crashScenarios: readonly CrashScenario[] = [
  {
    name: 'arm',
    async prepare() {
      return { type: 'armRecoveryIntent', args: [intent('crash')] };
    },
  },
  {
    name: 'claim',
    async prepare(session) {
      await session.storage.execute({
        type: 'armRecoveryIntent',
        args: [intent('crash')],
      });
      return { type: 'claimRecoveryDispatch', args: [claim('crash')] };
    },
  },
  {
    name: 'release',
    async prepare(session) {
      await prepared(session);
      return {
        type: 'releaseRecoveryDispatch',
        args: [
          {
            fingerprint: 'crash',
            dispatchAttemptId: 'attempt-crash',
            outcome: 'armed',
            now: later,
          },
        ],
      };
    },
  },
  {
    name: 'accept',
    async prepare(session) {
      await prepared(session);
      return {
        type: 'acceptRecoveryDispatch',
        args: [
          {
            fingerprint: 'crash',
            dispatchAttemptId: 'attempt-crash',
            turnId: 'turn',
            now: later,
          },
        ],
      };
    },
  },
  {
    name: 'observe',
    async prepare(session) {
      await prepared(session);
      return {
        type: 'observeRecoveryDispatchCorrelation',
        args: ['correlation-crash', 'observed', later],
      };
    },
  },
  {
    name: 'indeterminate',
    async prepare(session) {
      await prepared(session);
      return {
        type: 'markRecoveryDispatchIndeterminate',
        args: ['crash', 'attempt-crash', later],
      };
    },
  },
  {
    name: 'credential link',
    async prepare(session) {
      await prepared(session, 'profile');
      return {
        type: 'linkRecoveryCredentialAttempt',
        args: [
          {
            fingerprint: 'crash',
            dispatchAttemptId: 'attempt-crash',
            credentialAttemptId: 'credential',
            now: later,
          },
        ],
      };
    },
  },
  {
    name: 'owner fence',
    async prepare(session) {
      await prepared(session);
      return {
        type: 'indeterminatePreparedRecoveryDispatch',
        args: [
          {
            fingerprint: 'crash',
            dispatchAttemptId: 'attempt-crash',
            recoveryCorrelationId: 'correlation-crash',
            ownerId: 'owner',
            ownerPid: 123,
            now: later,
          },
        ],
      };
    },
  },
  {
    name: 'terminal',
    async prepare(session) {
      await prepared(session);
      await session.storage.execute({
        type: 'acceptRecoveryDispatch',
        args: [
          {
            fingerprint: 'crash',
            dispatchAttemptId: 'attempt-crash',
            turnId: 'turn',
            now: at,
          },
        ],
      });
      return {
        type: 'recordRecoveryTerminal',
        args: ['crash', 'succeeded', later],
      };
    },
  },
  {
    name: 'compensation mark',
    async prepare(session) {
      await prepared(session);
      await session.storage.execute({
        type: 'markRecoveryDispatchIndeterminate',
        args: ['crash', 'attempt-crash', at],
      });
      return {
        type: 'markRecoveryCompensation',
        args: ['crash', later, 'indeterminate'],
      };
    },
  },
  {
    name: 'compensation resolution',
    async prepare(session) {
      await prepared(session);
      await session.storage.execute({
        type: 'markRecoveryCompensation',
        args: ['crash', at, 'resumed'],
      });
      return {
        type: 'resolveRecoveryCompensationRecord',
        args: ['crash', later],
      };
    },
  },
  {
    name: 'cancel',
    async prepare(session) {
      await session.storage.execute({
        type: 'armRecoveryIntent',
        args: [intent('crash')],
      });
      return {
        type: 'cancelRecovery',
        args: ['crash', later, 'user-canceled'],
      };
    },
  },
  {
    name: 'retire waiting',
    async prepare(session) {
      await session.storage.execute({
        type: 'armRecoveryIntent',
        args: [intent('crash')],
      });
      return {
        type: 'retireWaitingRecovery',
        args: [
          {
            fingerprint: 'crash',
            outcome: 'canceled',
            reason: 'user-canceled',
            now: later,
          },
        ],
      };
    },
  },
  {
    name: 'bulk source cancellation',
    async prepare(session) {
      await session.storage.execute({
        type: 'armRecoveryIntent',
        args: [intent('crash')],
      });
      session.markSourceTerminated('thread-crash', 'turn');
      return { type: 'cancelSourceTerminatedRecoveries', args: [later] };
    },
  },
  {
    name: 'source cancellation',
    async prepare(session) {
      await session.storage.execute({
        type: 'armRecoveryIntent',
        args: [intent('crash')],
      });
      session.markSourceTerminated('thread-crash', 'turn');
      return {
        type: 'cancelRecoveryIfSourceTerminated',
        args: ['crash', later],
      };
    },
  },
  {
    name: 'shutdown fence',
    async prepare(session) {
      await session.storage.execute({
        type: 'armRecoveryIntent',
        args: [intent('crash')],
      });
      return { type: 'cancelShutdownRecoveries', args: [later] };
    },
  },
];

async function recoverySnapshot(
  session: RecoveryConformanceSession,
): Promise<unknown> {
  return {
    intent: await session.storage.execute({
      type: 'findRecoveryIntent',
      args: ['crash'],
    }),
    prepared: await session.storage.execute({
      type: 'preparedRecoveryDispatches',
      args: [],
    }),
  };
}

const recoveryCrashCases: readonly RecoveryConformanceCase[] =
  crashScenarios.map((scenario) => ({
    name: `preserves ${scenario.name} at rollback and acknowledgement boundaries`,
    run: async (harness) => {
      await withSession(harness, async (session) => {
        const command = await scenario.prepare(session);
        const before = await recoverySnapshot(session);
        session.failNextCommit();
        await assert.rejects(session.storage.execute(command), /commit fault/);
        await session.reopen();
        assert.deepEqual(await recoverySnapshot(session), before);
      });
      await withSession(harness, async (session) => {
        const command = await scenario.prepare(session);
        const before = await recoverySnapshot(session);
        session.loseNextAcknowledgement();
        await assert.rejects(
          session.storage.execute(command),
          /acknowledgement fault/,
        );
        await session.reopen();
        assert.notDeepEqual(await recoverySnapshot(session), before);
      });
    },
  }));

export const recoveryConformanceCases: readonly RecoveryConformanceCase[] = [
  ...basicRecoveryConformanceCases,
  ...recoveryCrashCases,
];

export function registerRecoveryConformance(
  runner: KernelConformanceRunner,
  harness: RecoveryConformanceHarness,
): void {
  runner.describe(`recovery conformance: ${harness.name}`, () => {
    for (const entry of recoveryConformanceCases)
      runner.it(entry.name, () => entry.run(harness));
  });
}
