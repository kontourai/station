import { CHAT_ATTACHMENT_MAX_COMMAND_JSON_BYTES } from '@kontourai/station-contracts/chat-attachment';
import { describe, expect, it } from 'vitest';
import {
  classifyMutationRoute,
  DOCUMENTED_SSE_READ_SURFACES,
  deriveBudgetPrincipal,
  RuntimeMutationBudget,
} from '../runtime-request-security.js';

describe('classifyMutationRoute', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'classifies %s as unbudgeted',
    (method) => {
      expect(classifyMutationRoute(method, '/api/projects')).toBe('unbudgeted');
    },
  );

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'classifies %s on a normal protected route as standard',
    (method) => {
      expect(classifyMutationRoute(method, '/api/projects')).toBe('standard');
    },
  );

  it('classifies public routes as unbudgeted even for mutating verbs', () => {
    expect(classifyMutationRoute('POST', '/api/system/liveness')).toBe(
      'standard', // liveness is GET-only in PUBLIC_ROUTES; POST is not public
    );
    expect(classifyMutationRoute('GET', '/api/system/liveness')).toBe(
      'unbudgeted',
    );
  });

  it('classifies streaming mutation routes as streaming', () => {
    expect(classifyMutationRoute('POST', '/api/agents/mybot/chat')).toBe(
      'streaming',
    );
    expect(classifyMutationRoute('POST', '/api/orchestration/chat')).toBe(
      'streaming',
    );
    expect(
      classifyMutationRoute('POST', '/api/orchestration/chat/conv123/continue'),
    ).toBe('streaming');
    expect(classifyMutationRoute('POST', '/agents/mybot/invoke/stream')).toBe(
      'streaming',
    );
  });

  it('does not classify a non-streaming POST under /api/agents as streaming', () => {
    expect(classifyMutationRoute('POST', '/api/agents')).toBe('standard');
    expect(classifyMutationRoute('DELETE', '/api/agents/mybot')).toBe(
      'standard',
    );
  });

  it('GET on a streaming route path is unbudgeted (not streaming)', () => {
    expect(classifyMutationRoute('GET', '/api/agents/mybot/chat')).toBe(
      'unbudgeted',
    );
  });

  it('DOCUMENTED_SSE_READ_SURFACES pins every GET SSE read surface (documentary, not a gate)', () => {
    // Unlike STREAMING_MUTATION_PREFIXES (which the classifier consults to pick
    // the streaming rate bucket), this list is documentary only — GETs are
    // unbudgeted by the non-mutation rule, not by membership here. The two
    // assertions below are load-bearing: toEqual catches a silent deletion, and
    // the POST loop proves documenting a read does NOT exempt a mutating verb
    // on the same path (the exact mistake a family-level exemption would make).
    expect(DOCUMENTED_SSE_READ_SURFACES).toEqual([
      '/events',
      '/api/orchestration/events',
      '/monitoring/events',
      '/scheduler/events',
    ]);
    for (const path of DOCUMENTED_SSE_READ_SURFACES) {
      expect(classifyMutationRoute('POST', path)).toBe('standard');
    }
  });

  it('scheduler and monitoring families are NOT exempted — only their GET SSE leaf is unbudgeted', () => {
    // The original archive#514 brief proposed exempting /scheduler/** and
    // /monitoring/** wholesale as "streaming" families. That would have
    // unbudgeted every mutating verb under them: POST /scheduler/webhook,
    // POST /scheduler/jobs, PUT/DELETE /scheduler/jobs/:target (all real CRUD
    // registered in routes/operations/scheduler.ts), and any future monitoring
    // mutation. Only the GET SSE leaf (/.../events) is unbudgeted, by virtue
    // of being a non-mutation read. This pins the distinction in both
    // directions.
    expect(classifyMutationRoute('POST', '/scheduler/webhook')).toBe(
      'standard',
    );
    expect(classifyMutationRoute('POST', '/scheduler/jobs')).toBe('standard');
    expect(classifyMutationRoute('PUT', '/scheduler/jobs/daily-sync')).toBe(
      'standard',
    );
    expect(classifyMutationRoute('DELETE', '/scheduler/jobs/daily-sync')).toBe(
      'standard',
    );
    // monitoring.ts has no mutating routes today, but a future one under the
    // family prefix must NOT inherit a family-level exemption:
    expect(classifyMutationRoute('POST', '/monitoring/stats')).toBe('standard');
    // The GET SSE leaves are unbudgeted (non-mutation reads):
    expect(classifyMutationRoute('GET', '/scheduler/events')).toBe(
      'unbudgeted',
    );
    expect(classifyMutationRoute('GET', '/monitoring/events')).toBe(
      'unbudgeted',
    );
  });
});

describe('deriveBudgetPrincipal', () => {
  it('loopback mode produces a fixed shared key', () => {
    const p = deriveBudgetPrincipal('loopback');
    expect(p.key).toBe('loopback');
    expect(p.source).toBe('loopback');
  });

  it('hashes the credential under a transport-neutral prefix and never uses it raw', () => {
    const p = deriveBudgetPrincipal('bearer', 'secret-token-123');
    expect(p.key).toMatch(/^principal:[0-9a-f]{16}$/);
    expect(p.key).not.toContain('secret-token-123');
  });

  it('the same secret produces the same key regardless of source label (bearer vs session)', () => {
    // archive#514 security review: the budget key MUST follow the credential
    // value, not the transport it arrived on. A holder of one credential who
    // can present it as EITHER a bearer token OR a device-session cookie must
    // NOT get two rate budgets — that is a deterministic 2× bypass the caller
    // picks by omitting a header. The `source` label is kept on
    // BudgetPrincipal for telemetry only; it does not participate in the key.
    const bearer = deriveBudgetPrincipal('bearer', 'same-secret');
    const session = deriveBudgetPrincipal('session', 'same-secret');
    expect(bearer.key).toBe(session.key);
    expect(bearer.source).toBe('bearer');
    expect(session.source).toBe('session');
  });

  it('two different credentials produce different keys', () => {
    const a = deriveBudgetPrincipal('bearer', 'aaa');
    const b = deriveBudgetPrincipal('session', 'bbb');
    expect(a.key).not.toBe(b.key);
  });

  it('throws for a non-loopback source with no credential (fail closed, not the operator bucket)', () => {
    // Unreachable given current callers, but defensive: an unattributable
    // caller must NOT silently merge into Station's internal-token `loopback`
    // bucket. Fail closed.
    expect(() => deriveBudgetPrincipal('bearer')).toThrow();
    expect(() => deriveBudgetPrincipal('session')).toThrow();
  });
});

describe('RuntimeMutationBudget', () => {
  function makeBudget(opts: { now?: () => number } = {}) {
    return new RuntimeMutationBudget({
      now: opts.now ?? (() => 0),
      maxMutationsPerWindow: 3,
      maxStreamingPerWindow: 2,
      maxPerformanceDiagnosticPerWindow: 2,
      mutationWindowMs: 10_000,
      maxBudgetPrincipals: 4,
      maxMutationBodyBytes: 100,
      maxStreamingBodyBytes: 200,
    });
  }

  describe('rate budget', () => {
    it('returns undefined when under budget', () => {
      const b = makeBudget();
      b.recordMutation('user-a', 'standard');
      expect(b.retryAfterSeconds('user-a', 'standard')).toBeUndefined();
    });

    it('returns Retry-After when at the ceiling', () => {
      const now = { v: 0 };
      const b = makeBudget({ now: () => now.v });
      for (let i = 0; i < 3; i++) b.recordMutation('user-a', 'standard');
      expect(b.retryAfterSeconds('user-a', 'standard')).toBe(10);
    });

    it('standard and streaming have independent ceilings for the same principal', () => {
      const b = makeBudget();
      // Exhaust streaming.
      b.recordMutation('user-a', 'streaming');
      b.recordMutation('user-a', 'streaming');
      expect(b.retryAfterSeconds('user-a', 'streaming')).toBe(10);
      // Standard is still under budget.
      expect(b.retryAfterSeconds('user-a', 'standard')).toBeUndefined();
    });

    it('performance diagnostics remain bounded in an independent bucket', () => {
      const b = makeBudget();
      b.recordMutation('user-a', 'performance-diagnostic');
      b.recordMutation('user-a', 'performance-diagnostic');
      expect(b.retryAfterSeconds('user-a', 'performance-diagnostic')).toBe(10);
      expect(b.retryAfterSeconds('user-a', 'standard')).toBeUndefined();
    });

    it('different principals have independent budgets', () => {
      const b = makeBudget();
      for (let i = 0; i < 3; i++) b.recordMutation('user-a', 'standard');
      expect(b.retryAfterSeconds('user-a', 'standard')).toBe(10);
      expect(b.retryAfterSeconds('user-b', 'standard')).toBeUndefined();
    });

    it('the window expires and resets the budget', () => {
      const now = { v: 0 };
      const b = makeBudget({ now: () => now.v });
      for (let i = 0; i < 3; i++) b.recordMutation('user-a', 'standard');
      expect(b.retryAfterSeconds('user-a', 'standard')).toBe(10);
      now.v = 11_000;
      expect(b.retryAfterSeconds('user-a', 'standard')).toBeUndefined();
    });

    it('unbudgeted class is never rate-limited', () => {
      const b = makeBudget();
      expect(b.retryAfterSeconds('user-a', 'unbudgeted')).toBeUndefined();
      b.recordMutation('user-a', 'unbudgeted'); // no-op
      expect(b.retryAfterSeconds('user-a', 'standard')).toBeUndefined();
    });
  });

  describe('body-byte ceiling', () => {
    it('returns the standard ceiling for standard class', () => {
      expect(makeBudget().bodyByteCeiling('standard')).toBe(100);
    });

    it('returns the streaming ceiling for streaming class', () => {
      expect(makeBudget().bodyByteCeiling('streaming')).toBe(200);
    });
  });

  describe('LRU eviction', () => {
    it('evicts the least-recently-used principal at capacity', () => {
      const b = makeBudget();
      // maxBudgetPrincipals is 4. Fill to 4 distinct principals.
      for (let i = 0; i < 4; i++) b.recordMutation(`user-${i}`, 'standard');
      // One more evicts the oldest (user-0).
      b.recordMutation('user-4', 'standard');
      // user-0's budget was evicted — recording again starts fresh.
      b.recordMutation('user-0', 'standard');
      expect(b.retryAfterSeconds('user-0', 'standard')).toBeUndefined();
    });
  });

  describe('clearBudget', () => {
    it('removes a principal from the rate map', () => {
      const b = makeBudget();
      for (let i = 0; i < 3; i++) b.recordMutation('user-a', 'standard');
      expect(b.retryAfterSeconds('user-a', 'standard')).toBe(10);
      b.clearBudget('user-a');
      expect(b.retryAfterSeconds('user-a', 'standard')).toBeUndefined();
    });
  });

  // archive#1885: the streaming body ceiling and the attachment contract are
  // NOT independent constants that must agree by coincidence — the default
  // ceiling is DERIVED from the contract (see runtime-request-security.ts).
  // This test pins that derivation: it fails if the default ever drops below
  // the maximum legitimate relay body the chat route accepts, whether because
  // someone hardcodes a smaller number or because the attachment allowance
  // grows without the ceiling following it. Without this relationship, a
  // ~1.5 MB phone screenshot passes the UI picker and the attachment
  // validator, then 413s on the internal relay hop.
  describe('streaming ceiling derives from the attachment contract (station#1885)', () => {
    it('the default streaming ceiling accommodates the maximum attachment command body', () => {
      const defaultBudget = new RuntimeMutationBudget();
      expect(defaultBudget.bodyByteCeiling('streaming')).toBeGreaterThanOrEqual(
        CHAT_ATTACHMENT_MAX_COMMAND_JSON_BYTES,
      );
    });

    it('a caller can still set a tighter ceiling, but the default never undercuts the contract', () => {
      // An explicit caller-provided ceiling is respected (test harnesses and
      // any future deployment that wants a different bound)...
      const tight = new RuntimeMutationBudget({ maxStreamingBodyBytes: 500 });
      expect(tight.bodyByteCeiling('streaming')).toBe(500);
      // ...but omitting the option — what production does — must always pick a
      // default that is at least the contract maximum.
      const productionDefault = new RuntimeMutationBudget();
      expect(
        productionDefault.bodyByteCeiling('streaming'),
      ).toBeGreaterThanOrEqual(CHAT_ATTACHMENT_MAX_COMMAND_JSON_BYTES);
    });
  });
});
