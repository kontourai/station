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
  ALLOWANCE_SUPERSESSION_SCAN_LIMIT,
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
function codexUsageLimitDetailsFor(
  resetAtMs: number,
  codexErrorInfo = 'usageLimitExceeded',
) {
  const state = {};
  observeCodexRateLimits(state, {
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 100, resetsAt: resetAtMs / 1_000 },
    },
  });
  const usageLimit = codexUsageLimitDetails(state, codexErrorInfo);
  if (!usageLimit) throw new Error('fixture: not a usage limit');
  return {
    additionalDetails: undefined,
    codexErrorInfo,
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
    superseded?: (refusal: AllowanceRefusalRow) => boolean;
    now?: number;
  } = {},
) {
  const connection = options.connection ?? claude;
  return projectEngineAllowanceEvidence({
    connections: [connection],
    refusals,
    superseded: options.superseded ?? (() => false),
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

  test('supersession is asked of the newest fresh refusal per account only', () => {
    const newer = refusal({ observedAt: at(-HOUR), globalSequence: 20 });
    const older = refusal({ observedAt: at(-2 * HOUR), globalSequence: 10 });
    const asked: number[] = [];
    expect(
      project([newer, older], {
        superseded: (row) => {
          asked.push(row.globalSequence);
          return true;
        },
      }),
    ).toBeUndefined();
    // The older refusal is not shown in the newer one's place.
    expect(asked).toEqual([20]);
  });

  test('proxy-routed runs do not speak for the account; a proxied engine is not marked', () => {
    expect(
      project([refusal({ observedAt: at(-HOUR), proxyRouted: true })]),
    ).toBeUndefined();
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

describe('Codex refusals', () => {
  const codex: AllowanceEvidenceConnection = {
    id: 'codex',
    provider: 'codex',
    profileRefs: [],
    proxyRouted: false,
  };
  const codexRefusal = (codexErrorInfo: string, code?: string) =>
    refusal({
      observedAt: at(-HOUR),
      provider: 'codex',
      accountKey: usageCredentialAccountKey('codex', null),
      ...(code ? { code } : { code: undefined }),
      details: codexUsageLimitDetailsFor(NOW + 2 * HOUR, codexErrorInfo),
    });

  test('a per-minute rate limit is not the allowance running out', () => {
    // The adapter classifies both as a usage limit (for recovery's wait).
    expect(codexRefusal('rateLimitExceeded').details).toMatchObject({
      usageLimit: true,
      scope: 'account',
    });
    expect(
      project([codexRefusal('rateLimitExceeded', 'rateLimitExceeded')], {
        connection: codex,
      }),
    ).toBeUndefined();
    // The `error` notification records it in details with no `code`.
    expect(
      project([codexRefusal('rateLimitExceeded')], { connection: codex }),
    ).toBeUndefined();
    expect(
      project([codexRefusal('usageLimitExceeded')], { connection: codex }),
    ).toHaveLength(1);
    // A rate limit newer than a usage limit does not hide the usage limit.
    expect(
      project(
        [
          codexRefusal('rateLimitExceeded', 'rateLimitExceeded'),
          { ...codexRefusal('usageLimitExceeded'), globalSequence: 5 },
        ],
        { connection: codex },
      ),
    ).toHaveLength(1);
  });

  test('a Codex refusal that does not say which limit is not counted', () => {
    const unlabeled = codexRefusal('usageLimitExceeded');
    const { codexErrorInfo: _dropped, ...details } = unlabeled.details!;
    expect(
      project([{ ...unlabeled, details }], { connection: codex }),
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

  /**
   * The start events an adapter persists for one process epoch: Claude Code
   * and Codex record the credential account key; ACP records its connection
   * and no key.
   */
  function startSession(
    provider: string,
    threadId: string,
    profileRef: string | null,
    options: { modelRoute?: object; connectionId?: string } = {},
  ) {
    const account =
      provider === 'acp'
        ? {}
        : { usageAccountKey: usageCredentialAccountKey(provider, profileRef) };
    const metadata = {
      userId: 'reader',
      ...(options.connectionId ? { connectionId: options.connectionId } : {}),
    };
    store.appendEvent({
      eventId: `${threadId}-started`,
      provider,
      threadId,
      sessionId: threadId,
      createdAt: new Date().toISOString(),
      method: 'session.started',
      initialState: 'created',
      metadata: { ...metadata, cwd: '/work', ...account },
    } as never);
    store.appendEvent({
      eventId: `${threadId}-configured`,
      provider,
      threadId,
      sessionId: threadId,
      createdAt: new Date().toISOString(),
      method: 'session.configured',
      cwd: '/work',
      metadata: {
        ...metadata,
        ...account,
        ...(options.modelRoute ? { modelRoute: options.modelRoute } : {}),
      },
    } as never);
  }
  const startClaudeSession = (
    threadId: string,
    profileRef: string | null,
    options: { modelRoute?: object; connectionId?: string } = {},
  ) => startSession('claude', threadId, profileRef, options);

  function acceptTurn(
    threadId: string,
    turnId: string,
    finishReason: string,
    provider = 'claude',
  ) {
    store.appendEvent({
      eventId: `${turnId}-completed`,
      provider,
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

  test('a later accepted turn on the same account supersedes the refusal; another account, an earlier turn or a proxied run does not', () => {
    startClaudeSession('before', null);
    acceptTurn('before', 'before-stop', 'stop');
    startClaudeSession('refused', null);
    store.appendEvent(
      claudeUsageLimitError('refused', Date.now() + 2 * HOUR) as never,
    );
    expect(read()).toHaveLength(1);
    startClaudeSession('on-work', 'work');
    acceptTurn('on-work', 'on-work-stop', 'stop');
    expect(read()).toHaveLength(1);
    startClaudeSession('proxied', null, {
      modelRoute: {
        connectionId: 'local-proxy',
        label: 'Local',
        endpoint: 'http://127.0.0.1:4000',
      },
    });
    acceptTurn('proxied', 'proxied-stop', 'stop');
    expect(read()).toHaveLength(1);
    startClaudeSession('cleared', null);
    acceptTurn('cleared', 'cleared-stop', 'stop');
    expect(read()).toBeUndefined();
  });

  test('a turn accepted on another connection of the same account supersedes the refusal', () => {
    startClaudeSession('refused', null);
    store.appendEvent(
      claudeUsageLimitError('refused', Date.now() + 2 * HOUR) as never,
    );
    expect(read()).toHaveLength(1);
    // A second Claude Code connection running on the same default account.
    startClaudeSession('elsewhere', null, { connectionId: 'claude-work' });
    acceptTurn('elsewhere', 'elsewhere-stop', 'stop');
    expect(read()).toBeUndefined();
  });

  test('heavy traffic on another account cannot bring back a refusal a later turn cleared', () => {
    startClaudeSession('refused', null);
    store.appendEvent(
      claudeUsageLimitError('refused', Date.now() + 2 * HOUR) as never,
    );
    startClaudeSession('cleared', null);
    acceptTurn('cleared', 'cleared-stop', 'stop');
    // More newer accepted turns, on the same provider but another account,
    // than the former shared read held (1,000).
    startClaudeSession('busy', 'work');
    for (let index = 0; index < 1_001; index += 1)
      acceptTurn('busy', `busy-${index}`, 'stop');
    expect(read()).toBeUndefined();
  });

  test('the supersession check examines a bounded window and fails toward no label past it', () => {
    expect(ALLOWANCE_SUPERSESSION_SCAN_LIMIT).toBe(1_000);
    startClaudeSession('refused', null);
    store.appendEvent(
      claudeUsageLimitError('refused', Date.now() + 2 * HOUR) as never,
    );
    const check = () =>
      store.allowanceRefusalSupersession({
        provider: 'claude',
        observedAt: new Date(Date.now() - HOUR).toISOString(),
        globalSequence: 0,
        account: { accountKey: usageCredentialAccountKey('claude', null) },
      });
    // Unrelated traffic: another account's accepted turns.
    startClaudeSession('busy', 'work');
    for (
      let index = 0;
      index < ALLOWANCE_SUPERSESSION_SCAN_LIMIT - 1;
      index += 1
    )
      acceptTurn('busy', `busy-${index}`, 'stop');
    // Below the cap the whole window is read: still refused, still shown.
    expect(check()).toBe('none');
    expect(read()).toHaveLength(1);
    acceptTurn('busy', 'busy-cap', 'stop');
    // Exactly the cap, all read: a complete answer, still shown.
    expect(check()).toBe('none');
    expect(read()).toHaveLength(1);
    acceptTurn('busy', 'busy-past-cap', 'stop');
    // Past it the read stops at the cap and the refusal is not shown.
    expect(check()).toBe('scan-capped');
    expect(read()).toBeUndefined();
  });

  test("an ACP refusal is its connection's; only a turn accepted on that connection clears it", () => {
    const opencode = { id: 'opencode', provider: 'acp', profileRefs: [] };
    const readAcp = () =>
      readEngineAllowanceEvidence(
        store,
        [{ ...opencode, proxyRouted: false }],
        Date.now(),
      ).get('opencode');
    startSession('acp', 'acp-refused', null, { connectionId: 'opencode' });
    store.appendEvent({
      eventId: 'acp-refused-error',
      provider: 'acp',
      threadId: 'acp-refused',
      turnId: 'acp-refused-turn',
      createdAt: new Date().toISOString(),
      method: 'runtime.error',
      ...providerFailure('quota_exhausted'),
      severity: 'error',
      code: PROVIDER_PLAN_QUOTA_EXHAUSTED_CODE,
      message: 'quota',
      details: acpPlanQuotaDetails(),
    } as never);
    expect(readAcp()).toEqual([
      expect.objectContaining({
        source: 'plan-quota',
        applies: 'current-account',
      }),
    ]);
    startSession('acp', 'acp-kiro', null, { connectionId: 'kiro' });
    acceptTurn('acp-kiro', 'acp-kiro-stop', 'stop', 'acp');
    expect(readAcp()).toHaveLength(1);
    startSession('acp', 'acp-again', null, { connectionId: 'opencode' });
    acceptTurn('acp-again', 'acp-again-stop', 'stop', 'acp');
    expect(readAcp()).toBeUndefined();
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
  test('dispatch, chat and agent listings never read allowance evidence', async () => {
    const listAllowanceRefusals = vi.fn(() => [
      refusal({
        observedAt: new Date(Date.now() - HOUR).toISOString(),
        accountKey: usageCredentialAccountKey('claude', 'work'),
        details: { ...claudeUsageLimitDetails(Date.now() + 2 * HOUR) },
      }),
    ]);
    const allowanceRefusalSupersession = vi.fn(() => 'none' as const);
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
    service.setAllowanceEvidenceSource({
      listAllowanceRefusals,
      allowanceRefusalSupersession,
    });
    // chat.ts, runtime-routes agent availability/saves, tool-library and
    // readiness all read this listing.
    const [dispatched] = await service.listRuntimeConnections();
    expect(dispatched?.id).toBe('claude');
    expect(dispatched).not.toHaveProperty('allowanceEvidence');
    await service.listEngineConnectionStates();
    await service.listConnections();
    await service.listRuntimeConnectionInventory();
    await service.listRuntimeConnectionCatalog();
    expect(listAllowanceRefusals).not.toHaveBeenCalled();
    expect(allowanceRefusalSupersession).not.toHaveBeenCalled();

    // The served listing reads it: the spy is live.
    const [served] = (
      await service.listRuntimeConnectionInventory({
        withAllowanceEvidence: true,
      })
    ).connections;
    expect(listAllowanceRefusals).toHaveBeenCalledTimes(1);
    expect(served?.allowanceEvidence).toHaveLength(1);
    // The single read (dispatch, the CLI, the engine page's editable copy)
    // stays free of it.
    expect(await service.getConnection('claude')).not.toHaveProperty(
      'allowanceEvidence',
    );
    expect(listAllowanceRefusals).toHaveBeenCalledTimes(1);
  });

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
    const served = async () =>
      (
        await service.listRuntimeConnectionInventory({
          withAllowanceEvidence: true,
        })
      ).connections;
    const [unwired] = await served();
    expect(unwired).not.toHaveProperty('allowanceEvidence');

    service.setAllowanceEvidenceSource({
      listAllowanceRefusals,
      allowanceRefusalSupersession: vi.fn(() => 'none' as const),
    });
    const [connection] = await served();
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
    const [failed] = await served();
    expect(failed).not.toHaveProperty('allowanceEvidence');
  });

  test('an ACP engine view carries its plan-quota refusal', async () => {
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => []),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [] as any,
      async () => [
        { id: 'kiro', name: 'Kiro', command: 'kiro', enabled: true },
      ],
      () => ({ connections: [{ id: 'kiro', status: 'available' }] }),
      async () => ({}) as any,
      vi.fn(),
    );
    const allowanceRefusalSupersession = vi.fn(() => 'none' as const);
    service.setAllowanceEvidenceSource({
      listAllowanceRefusals: () => [
        refusal({
          observedAt: new Date(Date.now() - HOUR).toISOString(),
          provider: 'acp',
          connectionId: 'kiro',
          accountKey: undefined,
          code: PROVIDER_PLAN_QUOTA_EXHAUSTED_CODE,
          details: acpPlanQuotaDetails(),
        }),
      ],
      allowanceRefusalSupersession,
    });
    const kiro = (
      await service.listRuntimeConnectionCatalog({
        withAllowanceEvidence: true,
      })
    ).find((connection) => connection.id === 'kiro');
    // The inspector's ACP view: no `config.provider`, `engineId: 'acp'`.
    expect(kiro?.config).not.toHaveProperty('provider');
    expect(kiro?.config.engineId).toBe('acp');
    expect(kiro?.allowanceEvidence).toEqual([
      expect.objectContaining({
        source: 'plan-quota',
        account: { kind: 'default' },
        applies: 'current-account',
      }),
    ]);
    expect(allowanceRefusalSupersession).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'acp',
        account: { connectionId: 'kiro' },
      }),
    );
  });
});
