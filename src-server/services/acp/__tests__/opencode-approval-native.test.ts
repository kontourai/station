import { describe, expect, test } from 'vitest';
import { loadOpenCodeFixture } from '../../../providers/__tests__/opencode-serve-replay.js';
import type { AcpAppliedApprovalMode } from '../../../providers/adapters/acp-approval-mode.js';
import {
  evaluateOpenCodeRules,
  type OpenCodeNativeRule,
  openCodeGrantCovers,
  openCodeNativeApprovalRules,
  openCodeNativeAskAnswer,
  openCodeNativeModeAllows,
  openCodeSavedApprovalOverrides,
} from '../opencode-approval-native.js';

/** What 2.3.0 answered for the saved approvals and `build`'s rules, after an `always`. */
function captured(): {
  agentRules: OpenCodeNativeRule[];
  saved: Array<{ action: string; resource: string }>;
} {
  const records = loadOpenCodeFixture('permission-saved');
  const answer = (path: string) =>
    records.find((record) => record.kind === 'http' && record.path === path)
      ?.response as { data: unknown };
  return {
    agentRules: (
      answer('/api/agent/build').data as { permissions: OpenCodeNativeRule[] }
    ).permissions,
    saved: answer('/api/permission/saved').data as Array<{
      action: string;
      resource: string;
    }>,
  };
}

describe('evaluateOpenCodeRules (OpenCode 2.3.0 evaluateInput)', () => {
  test('a configured deny wins before any saved approval', () => {
    const configured: OpenCodeNativeRule[] = [
      { action: 'shell', resource: 'rm *', effect: 'deny' },
      { action: 'shell', resource: '*', effect: 'ask' },
    ];
    // Last match among configured is `ask` for `rm -rf`, so no deny...
    expect(
      evaluateOpenCodeRules(
        { action: 'shell', resources: ['rm -rf x'] },
        configured,
        [{ action: 'shell', resource: '*' }],
      ),
    ).toBe('allow');
    // ...but a deny that is the last configured match holds against a saved allow.
    expect(
      evaluateOpenCodeRules(
        { action: 'shell', resources: ['rm -rf x'] },
        [...configured].reverse(),
        [{ action: 'shell', resource: '*' }],
      ),
    ).toBe('deny');
  });

  test('saved approvals follow the configured rules, last match wins, and one asking resource asks', () => {
    const configured: OpenCodeNativeRule[] = [
      { action: '*', resource: '*', effect: 'allow' },
      { action: 'shell', resource: '*', effect: 'ask' },
    ];
    const saved = [{ action: 'shell', resource: 'echo *' }];
    expect(
      evaluateOpenCodeRules(
        { action: 'shell', resources: ['echo hi'] },
        configured,
        saved,
      ),
    ).toBe('allow');
    expect(
      evaluateOpenCodeRules(
        { action: 'shell', resources: ['echo hi', 'ls'] },
        configured,
        saved,
      ),
    ).toBe('ask');
    expect(
      evaluateOpenCodeRules({ action: 'grep', resources: ['x'] }, [], []),
    ).toBe('ask');
  });

  test("the captured `always` approval overrides Station's confined rules, not full access", () => {
    const { agentRules, saved } = captured();
    expect(saved).toEqual([
      expect.objectContaining({ action: 'shell', resource: 'echo *' }),
    ]);
    expect(
      openCodeSavedApprovalOverrides('confined', agentRules, saved).map(
        (rule) => `${rule.action} ${rule.resource}`,
      ),
    ).toEqual(['shell echo *']);
    expect(openCodeSavedApprovalOverrides('full', agentRules, saved)).toEqual(
      [],
    );
    // An approval for an action Station does not govern is no override.
    expect(
      openCodeSavedApprovalOverrides('confined', agentRules, [
        { action: 'read', resource: '*' },
      ]),
    ).toEqual([]);
  });

  test('the confined rules ask for every governed action after the agent allows it', () => {
    const { agentRules } = captured();
    const configured = [
      ...agentRules,
      ...openCodeNativeApprovalRules('confined'),
    ];
    for (const action of [
      'shell',
      'edit',
      'webfetch',
      'websearch',
      'github_create_issue',
    ])
      expect(
        evaluateOpenCodeRules(
          { action, resources: ['anything'] },
          configured,
          [],
        ),
      ).toBe('ask');
    // A child session asks too, and Station rejects it (it would run its own
    // agent's rules, not these).
    expect(
      evaluateOpenCodeRules(
        { action: 'subagent', resources: ['general'] },
        configured,
        [],
      ),
    ).toBe('ask');
    expect(
      openCodeNativeAskAnswer({
        mode: 'never',
        agentRules,
        request: { action: 'subagent', resources: ['general'] },
        granted: true,
      }),
    ).toBe('reject');
  });

  test("Station's rules are asks only, and none at full access", () => {
    expect(openCodeNativeApprovalRules('full')).toEqual([]);
    const confined = openCodeNativeApprovalRules('confined');
    expect(confined.length).toBeGreaterThan(0);
    expect(confined.every((rule) => rule.effect === 'ask')).toBe(true);
  });

  test('a saved allow for subagent refuses a governed start', () => {
    const { agentRules } = captured();
    expect(
      openCodeSavedApprovalOverrides('confined', agentRules, [
        { action: 'subagent', resource: '*' },
      ]),
    ).toEqual([{ action: 'subagent', resource: '*' }]);
  });

  test('modes answer without a person only what they cover', () => {
    expect(openCodeNativeModeAllows('never', 'shell')).toBe(true);
    expect(openCodeNativeModeAllows('auto', 'edit')).toBe(true);
    expect(openCodeNativeModeAllows('auto', 'shell')).toBe(false);
    expect(openCodeNativeModeAllows('ask', 'edit')).toBe(false);
    expect(openCodeNativeModeAllows(undefined, 'edit')).toBe(false);
  });

  /** The plan agent's rules as 2.3.0 answered them with no global allow. */
  const planRules = (): OpenCodeNativeRule[] => {
    const record = loadOpenCodeFixture('plan-deny').find(
      (line) => line.path === '/api/agent/plan',
    );
    if (!record) throw new Error('plan-deny recorded no plan agent');
    return (record.response as { data: { permissions: OpenCodeNativeRule[] } })
      .data.permissions;
  };

  type Outcome = 'runs' | 'denied' | 'asks';
  /**
   * What happens to a request end to end: OpenCode evaluates the agent's
   * rules followed by Station's session rules (as `configured`), and an ask
   * goes to Station, which answers it with `openCodeNativeAskAnswer` given
   * the agent's own rules while the confined rules govern.
   */
  function outcome(
    agentRules: readonly OpenCodeNativeRule[],
    mode: AcpAppliedApprovalMode,
    request: { action: string; resources: string[] },
  ): Outcome {
    const floor = mode === 'never' ? 'full' : 'confined';
    const engine = evaluateOpenCodeRules(
      request,
      [...agentRules, ...openCodeNativeApprovalRules(floor)],
      [],
    );
    if (engine === 'allow') return 'runs';
    if (engine === 'deny') return 'denied';
    const answer = openCodeNativeAskAnswer({
      mode,
      agentRules: floor === 'confined' ? agentRules : undefined,
      request,
      granted: false,
    });
    return answer === 'once' ? 'runs' : answer === 'reject' ? 'denied' : 'asks';
  }
  const shell = { action: 'shell', resources: ['echo hi'] };
  const read = { action: 'read', resources: ['src/app.ts'] };
  const edit = { action: 'edit', resources: ['src/app.ts'] };

  test('a lockdown agent (deny all, allow shell and read) keeps its own answers under every mode', () => {
    const lockdown: OpenCodeNativeRule[] = [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'shell', resource: '*', effect: 'allow' },
      { action: 'read', resource: '*', effect: 'allow' },
    ];
    const table = (['never', 'ask', 'auto'] as const).map((mode) => [
      mode,
      outcome(lockdown, mode, shell),
      outcome(lockdown, mode, read),
      outcome(lockdown, mode, edit),
    ]);
    expect(table).toEqual([
      ['never', 'runs', 'runs', 'denied'],
      ['ask', 'asks', 'runs', 'denied'],
      ['auto', 'asks', 'runs', 'denied'],
    ]);
  });

  test("the plan agent's edit deny stays denied under full access, Ask and Auto", () => {
    const plan = planRules();
    for (const mode of ['never', 'ask', 'auto'] as const)
      expect(outcome(plan, mode, edit), mode).toBe('denied');
    // Its plan-file exception is the agent's: full access runs it, Ask asks,
    // Auto answers edits.
    const planFile = {
      action: 'edit',
      resources: ['{HOME}/.opencode/plan/next.md'],
    };
    expect(outcome(plan, 'never', planFile)).toBe('runs');
    expect(outcome(plan, 'ask', planFile)).toBe('asks');
    expect(outcome(plan, 'auto', planFile)).toBe('runs');
  });

  test('a narrower allow after a deny (`edit * deny, edit ? allow`) never widens the deny', () => {
    const narrowed: OpenCodeNativeRule[] = [
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'edit', resource: '?', effect: 'allow' },
    ];
    const one = { action: 'edit', resources: ['a'] };
    const longer = { action: 'edit', resources: ['ab'] };
    const both = { action: 'edit', resources: ['a', 'ab'] };
    const table = (['never', 'ask', 'auto'] as const).map((mode) => [
      mode,
      outcome(narrowed, mode, one),
      outcome(narrowed, mode, longer),
      outcome(narrowed, mode, both),
    ]);
    expect(table).toEqual([
      ['never', 'runs', 'denied', 'denied'],
      ['ask', 'asks', 'denied', 'denied'],
      ['auto', 'runs', 'denied', 'denied'],
    ]);
  });

  test("an agent's deny outranks a session grant", () => {
    expect(
      openCodeNativeAskAnswer({
        mode: 'auto',
        agentRules: [{ action: 'edit', resource: '*', effect: 'deny' }],
        request: edit,
        granted: true,
      }),
    ).toBe('reject');
    // Without the confined rules governing, Station keeps no deny of its own.
    expect(
      openCodeNativeAskAnswer({
        mode: 'never',
        agentRules: undefined,
        request: edit,
        granted: false,
      }),
    ).toBe('once');
  });

  test('a session grant covers the asked patterns of its action only', () => {
    const grant = { action: 'shell', patterns: ['echo *'] };
    expect(
      openCodeGrantCovers(grant, {
        action: 'shell',
        resources: ['echo hello-from-bash'],
      }),
    ).toBe(true);
    expect(
      openCodeGrantCovers(grant, { action: 'shell', resources: ['ls -a'] }),
    ).toBe(false);
    expect(
      openCodeGrantCovers(grant, {
        action: 'shell',
        resources: ['echo ok', 'rm -rf x'],
      }),
    ).toBe(false);
    expect(
      openCodeGrantCovers(grant, { action: 'edit', resources: ['echo x'] }),
    ).toBe(false);
    expect(openCodeGrantCovers(grant, { action: 'shell', resources: [] })).toBe(
      false,
    );
  });
});
