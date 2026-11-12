import { join } from 'node:path';
import { ENGINE_TURN_FAILED_CODE } from '@kontourai/station-contracts/provider';
import { PROVIDER_PLAN_QUOTA_EXHAUSTED_CODE } from '@kontourai/station-contracts/provider-failure';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  observeClaudeRateLimit,
  takeClaudeUsageLimitDetails,
} from '../../../providers/adapters/claude-usage-limit.js';
import {
  codexUsageLimitDetails,
  observeCodexRateLimits,
} from '../../../providers/adapters/codex-usage-limit.js';
import { usageCredentialAccountKey } from '../../../providers/app-home/app-home-profiles.js';
import { providerFailure } from '../../../providers/provider-failure.js';
import {
  classifyProviderQuotaFailure,
  providerQuotaEventDetails,
} from '../../../providers/provider-plan-quota.js';
import {
  type AllowanceEpochFactRow,
  type AllowanceRefusalRow,
  EventStore,
} from '../../orchestration/event-store.js';
import {
  ALLOWANCE_EVIDENCE_UNKNOWN_RESET_MS,
  type AllowanceEvidenceConnection,
  projectEngineAllowanceEvidence,
  readEngineAllowanceEvidence,
} from '../engine-allowance-evidence.js';
import { createConnectionServiceForTest } from './connection-service-test-helper.js';

const makeTempDir = trackTempDirs();
const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const HOUR = 60 * 60 * 1_000;
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

/** The details Claude Code's adapter attaches to a usage-limit stop. */
function claudeUsageLimitDetails(resetAtMs: number | undefined) {
  const state = {};
  observeClaudeRateLimit(state, {
    status: 'rejected',
    rateLimitType: 'five_hour',
    ...(resetAtMs === undefined ? {} : { resetsAt: resetAtMs / 1_000 }),
  } as never);
  const details = takeClaudeUsageLimitDetails(state, {
    terminal_reason: 'blocking_limit',
  });
  if (!details) throw new Error('fixture: no usage-limit details');
  return details;
}

/** The `runtime.error` claude-adapter-events.ts publishes for that stop. */
function claudeUsageLimitError(
  threadId: string,
  resetAtMs: number | undefined,
) {
  const details = claudeUsageLimitDetails(resetAtMs);
  return {
    eventId: `${threadId}-refused`,
    provider: 'claude',
    threadId,
    turnId: `${threadId}-turn`,
    createdAt: new Date().toISOString(),
    method: 'runtime.error' as const,
    ...providerFailure('quota_exhausted', 'failed', details.resetAt),
    severity: 'error' as const,
    code: ENGINE_TURN_FAILED_CODE,
    retriable: false,
    message: "You've hit your limit",
    details: { ...details },
  };
}

/** The details codex-adapter-notifications.ts attaches to a failed turn. */
function codexUsageLimitDetailsFor(resetAtMs: number) {
  const state = {};
  observeCodexRateLimits(state, {
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 100, resetsAt: resetAtMs / 1_000 },
    },
  });
  const usageLimit = codexUsageLimitDetails(state, 'usageLimitExceeded');
  return {
    additionalDetails: undefined,
    codexErrorInfo: 'usageLimitExceeded',
    ...usageLimit,
  };
}

/** The validated details the ACP adapter persists for a plan quota refusal. */
function acpPlanQuotaDetails() {
  const facts = classifyProviderQuotaFailure({
    code: -32603,
    message:
      'Usage limit reached for 5 hour. Your limit will reset at 2026-11-12 16:30:00',
  });
  if (!facts) throw new Error('fixture: quota did not classify');
  return providerQuotaEventDetails(facts);
}

function refusal(
  overrides: Partial<AllowanceRefusalRow> & { observedAt: string },
): AllowanceRefusalRow {
  return {
    eventId: 'refused',
    provider: 'claude',
    threadId: 'thread-1',
    globalSequence: 10,
    accountKey: usageCredentialAccountKey('claude', null),
    proxyRouted: false,
    code: ENGINE_TURN_FAILED_CODE,
    details: { ...claudeUsageLimitDetails(NOW + 3 * HOUR) },
    ...overrides,
  };
}

function accepted(
  overrides: Partial<AllowanceEpochFactRow>,
): AllowanceEpochFactRow {
  return {
    eventId: 'accepted',
    provider: 'claude',
    threadId: 'thread-2',
    observedAt: at(-30 * 60 * 1_000),
    globalSequence: 20,
    accountKey: usageCredentialAccountKey('claude', null),
    proxyRouted: false,
    ...overrides,
  };
}

const claude: AllowanceEvidenceConnection = {
  id: 'claude',
  provider: 'claude',
  profileRefs: ['work'],
  proxyRouted: false,
};

function project(
  refusals: AllowanceRefusalRow[],
  options: {
    connection?: AllowanceEvidenceConnection;
    acceptedTurns?: AllowanceEpochFactRow[];
    now?: number;
  } = {},
) {
  const connection = options.connection ?? claude;
  return projectEngineAllowanceEvidence({
    connections: [connection],
    refusals,
    acceptedTurns: options.acceptedTurns ?? [],
    now: options.now ?? NOW,
  }).get(connection.id);
}

describe('projectEngineAllowanceEvidence', () => {
  test('a usage-limit stop on the current account holds until the provider reset', () => {
    const evidence = project([refusal({ observedAt: at(-HOUR) })]);
    expect(evidence).toEqual([
      {
        source: 'usage-limit',
        account: { kind: 'default' },
        applies: 'current-account',
        observedAt: at(-HOUR),
        resetAt: at(3 * HOUR),
        expiresAt: at(3 * HOUR),
      },
    ]);
    // At the reset the evidence is gone, not "allowance left".
    expect(
      project([refusal({ observedAt: at(-HOUR) })], { now: NOW + 3 * HOUR }),
    ).toBeUndefined();
  });

  test('a stop with no reported reset holds for the bounded window only', () => {
    const row = refusal({
      observedAt: at(-HOUR),
      details: { ...claudeUsageLimitDetails(undefined) },
    });
    const evidence = project([row]);
    expect(evidence?.[0]).not.toHaveProperty('resetAt');
    expect(evidence?.[0]?.expiresAt).toBe(
      at(-HOUR + ALLOWANCE_EVIDENCE_UNKNOWN_RESET_MS),
    );
    expect(
      project([row], { now: NOW - HOUR + ALLOWANCE_EVIDENCE_UNKNOWN_RESET_MS }),
    ).toBeUndefined();
  });

  test('the refused account is named, and only the active one is current', () => {
    const onWork = refusal({
      observedAt: at(-HOUR),
      accountKey: usageCredentialAccountKey('claude', 'work'),
    });
    expect(project([onWork])?.[0]).toMatchObject({
      account: { kind: 'profile', ref: 'work' },
      applies: 'other-account',
    });
    expect(
      project([onWork], {
        connection: { ...claude, activeProfileRef: 'work' },
      })?.[0],
    ).toMatchObject({ applies: 'current-account' });
    // A key no saved profile hashes to (a removed profile) names nothing.
    expect(
      project([
        refusal({
          observedAt: at(-HOUR),
          accountKey: usageCredentialAccountKey('claude', 'removed'),
        }),
      ]),
    ).toBeUndefined();
    // A start that recorded no account key cannot be attributed.
    expect(
      project([refusal({ observedAt: at(-HOUR), accountKey: undefined })]),
    ).toBeUndefined();
  });

  test('a later accepted turn on the same account supersedes the refusal; another account does not', () => {
    const row = refusal({ observedAt: at(-HOUR) });
    expect(project([row], { acceptedTurns: [accepted({})] })).toBeUndefined();
    expect(
      project([row], {
        acceptedTurns: [
          accepted({ accountKey: usageCredentialAccountKey('claude', 'work') }),
        ],
      }),
    ).toHaveLength(1);
    // Accepted before the refusal says nothing about it.
    expect(
      project([row], { acceptedTurns: [accepted({ globalSequence: 5 })] }),
    ).toHaveLength(1);
  });

  test('proxy-routed runs do not speak for the account; a proxied engine is not marked', () => {
    expect(
      project([refusal({ observedAt: at(-HOUR), proxyRouted: true })]),
    ).toBeUndefined();
    expect(
      project([refusal({ observedAt: at(-HOUR) })], {
        acceptedTurns: [accepted({ proxyRouted: true })],
      }),
    ).toHaveLength(1);
    expect(
      project([refusal({ observedAt: at(-HOUR) })], {
        connection: { ...claude, proxyRouted: true },
      })?.[0]?.applies,
    ).toBe('proxy-route');
  });

  test('only provider allowance verdicts count', () => {
    // Station's own engine reports a model connection's 429 as quota.
    expect(
      project(
        [
          refusal({
            observedAt: at(-HOUR),
            provider: 'station-agent',
            code: 'station_agent_turn_failed',
            details: { httpStatus: 429 },
          }),
        ],
        {
          connection: {
            id: 'station-agent',
            provider: 'station-agent',
            profileRefs: [],
            proxyRouted: false,
          },
        },
      ),
    ).toBeUndefined();
    expect(
      project([
        refusal({
          observedAt: at(-HOUR),
          details: { usageLimit: true, scope: 'provider' },
        }),
      ]),
    ).toBeUndefined();
  });

  test('Codex usage-limit details and ACP plan quota project with their own timing', () => {
    expect(
      project(
        [
          refusal({
            observedAt: at(-HOUR),
            provider: 'codex',
            code: 'usageLimitExceeded',
            accountKey: usageCredentialAccountKey('codex', null),
            details: codexUsageLimitDetailsFor(NOW + 2 * HOUR),
          }),
        ],
        {
          connection: {
            id: 'codex',
            provider: 'codex',
            profileRefs: [],
            proxyRouted: false,
          },
        },
      )?.[0],
    ).toMatchObject({ source: 'usage-limit', resetAt: at(2 * HOUR) });

    const acp: AllowanceEvidenceConnection = {
      id: 'opencode',
      provider: 'acp',
      profileRefs: [],
      proxyRouted: false,
    };
    const plan = refusal({
      observedAt: at(-HOUR),
      provider: 'acp',
      connectionId: 'opencode',
      accountKey: undefined,
      code: PROVIDER_PLAN_QUOTA_EXHAUSTED_CODE,
      details: acpPlanQuotaDetails(),
    });
    const evidence = project([plan], { connection: acp });
    // The civil reset text has no timezone, so it is display only.
    expect(evidence?.[0]).toEqual({
      source: 'plan-quota',
      account: { kind: 'default' },
      applies: 'current-account',
      observedAt: at(-HOUR),
      resetReported: '2026-11-12 16:30:00',
      expiresAt: at(-HOUR + ALLOWANCE_EVIDENCE_UNKNOWN_RESET_MS),
    });
    // ACP always records its connection; without one it is not attributed.
    expect(
      project([{ ...plan, connectionId: undefined }], { connection: acp }),
    ).toBeUndefined();
    // Another ACP connection's refusal is not this one's.
    expect(
      project([{ ...plan, connectionId: 'kiro' }], { connection: acp }),
    ).toBeUndefined();
  });
});

describe('recorded refusals read from the event store', () => {
  let home: string;
  let store: EventStore;
  beforeEach(() => {
    home = makeTempDir('allowance-evidence-');
    store = new EventStore(join(home, 'events.sqlite'));
  });
  afterEach(() => store.close());

  /** The start events claude-adapter.ts persists for one process epoch. */
  function startClaudeSession(
    threadId: string,
    profileRef: string | null,
    options: { modelRoute?: object; connectionId?: string } = {},
  ) {
    const usageAccountKey = usageCredentialAccountKey('claude', profileRef);
    const metadata = {
      userId: 'reader',
      ...(options.connectionId ? { connectionId: options.connectionId } : {}),
    };
    store.appendEvent({
      eventId: `${threadId}-started`,
      provider: 'claude',
      threadId,
      sessionId: threadId,
      createdAt: new Date().toISOString(),
      method: 'session.started',
      initialState: 'created',
      metadata: { ...metadata, cwd: '/work', usageAccountKey },
    });
    store.appendEvent({
      eventId: `${threadId}-configured`,
      provider: 'claude',
      threadId,
      sessionId: threadId,
      createdAt: new Date().toISOString(),
      method: 'session.configured',
      cwd: '/work',
      metadata: {
        ...metadata,
        usageAccountKey,
        ...(options.modelRoute ? { modelRoute: options.modelRoute } : {}),
      },
    });
  }

  function acceptTurn(threadId: string, turnId: string, finishReason: string) {
    store.appendEvent({
      eventId: `${turnId}-completed`,
      provider: 'claude',
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
      method: 'turn.completed',
      finishReason,
    } as never);
  }

  const read = (connection: Partial<AllowanceEvidenceConnection> = {}) =>
    readEngineAllowanceEvidence(
      store,
      [{ ...claude, ...connection }],
      Date.now(),
    ).get('claude');

  test('a usage-limit stop is scoped to the account and route its epoch recorded', () => {
    // The SDK reports whole epoch seconds.
    const resetAt = (Math.floor(Date.now() / 1_000) + 2 * 60 * 60) * 1_000;
    startClaudeSession('default-run', null);
    store.appendEvent(claudeUsageLimitError('default-run', resetAt) as never);
    startClaudeSession('work-run', 'work');
    store.appendEvent(claudeUsageLimitError('work-run', resetAt) as never);
    startClaudeSession('proxied-run', null, {
      modelRoute: {
        connectionId: 'local-proxy',
        label: 'Local',
        endpoint: 'http://127.0.0.1:4000',
      },
    });
    store.appendEvent(claudeUsageLimitError('proxied-run', resetAt) as never);

    const evidence = read({ activeProfileRef: 'work' });
    expect(evidence).toEqual([
      expect.objectContaining({
        account: { kind: 'profile', ref: 'work' },
        applies: 'current-account',
        resetAt: new Date(resetAt).toISOString(),
      }),
      expect.objectContaining({
        account: { kind: 'default' },
        applies: 'other-account',
      }),
    ]);
  });

  test('a refusal on a proxy-routed run is not the account’s', () => {
    startClaudeSession('proxied-only', null, {
      modelRoute: {
        connectionId: 'local-proxy',
        label: 'Local',
        endpoint: 'http://127.0.0.1:4000',
      },
    });
    store.appendEvent(
      claudeUsageLimitError('proxied-only', Date.now() + 2 * HOUR) as never,
    );
    expect(read()).toBeUndefined();
  });

  test('only a turn the provider finished supersedes the refusal', () => {
    startClaudeSession('refused', null);
    store.appendEvent(
      claudeUsageLimitError('refused', Date.now() + 2 * HOUR) as never,
    );
    startClaudeSession('later', null);
    acceptTurn('later', 'later-cancelled', 'cancelled');
    expect(read()).toHaveLength(1);
    acceptTurn('later', 'later-stop', 'stop');
    expect(read()).toBeUndefined();
  });

  test('a recorded connection id outranks the provider fallback', () => {
    startClaudeSession('elsewhere', null, { connectionId: 'claude-work' });
    store.appendEvent(
      claudeUsageLimitError('elsewhere', Date.now() + 2 * HOUR) as never,
    );
    expect(read()).toBeUndefined();
  });
});

describe('engine connection listing', () => {
  test('the engine view carries the evidence its source records, per the active account', async () => {
    const listAllowanceRefusals = vi.fn(() => [
      refusal({
        observedAt: new Date(Date.now() - HOUR).toISOString(),
        accountKey: usageCredentialAccountKey('claude', 'work'),
        details: { ...claudeUsageLimitDetails(Date.now() + 2 * HOUR) },
      }),
    ]);
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => []),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () =>
        [
          {
            provider: 'claude',
            metadata: {
              displayName: 'Claude Code',
              description: 'claude',
              capabilities: ['agent-runtime'],
              runtimeId: 'claude',
              executionClass: 'connected',
            },
            getPrerequisites: vi.fn().mockResolvedValue([]),
            listModels: vi.fn().mockResolvedValue([]),
          },
        ] as any,
      async () => [],
      () => ({ connections: [] }),
      async () =>
        ({
          agentConnections: {
            claude: {
              credentialRecovery: {
                profiles: [{ ref: 'work' }],
                activeProfileRef: 'work',
              },
            },
          },
        }) as any,
      vi.fn(),
    );
    const [unwired] = await service.listRuntimeConnections();
    expect(unwired).not.toHaveProperty('allowanceEvidence');

    service.setAllowanceEvidenceSource({
      listAllowanceRefusals,
      listAllowanceAcceptedTurns: vi.fn(() => []),
    });
    const [connection] = await service.listRuntimeConnections();
    expect(connection?.allowanceEvidence).toEqual([
      expect.objectContaining({
        account: { kind: 'profile', ref: 'work' },
        applies: 'current-account',
      }),
    ]);

    // A failed read is unknown: the view carries nothing, not "ok".
    listAllowanceRefusals.mockImplementation(() => {
      throw new Error('database is locked');
    });
    const [failed] = await service.listRuntimeConnections();
    expect(failed).not.toHaveProperty('allowanceEvidence');
  });
});
