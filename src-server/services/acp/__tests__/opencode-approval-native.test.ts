import { describe, expect, test } from 'vitest';
import { loadOpenCodeFixture } from '../../../providers/__tests__/opencode-serve-replay.js';
import {
  evaluateOpenCodeRules,
  type OpenCodeNativeRule,
  openCodeNativeApprovalRules,
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
    expect(
      evaluateOpenCodeRules(
        { action: 'subagent', resources: ['general'] },
        configured,
        [],
      ),
    ).toBe('deny');
  });

  test('modes answer without a person only what they cover', () => {
    expect(openCodeNativeModeAllows('never', 'shell')).toBe(true);
    expect(openCodeNativeModeAllows('auto', 'edit')).toBe(true);
    expect(openCodeNativeModeAllows('auto', 'shell')).toBe(false);
    expect(openCodeNativeModeAllows('ask', 'edit')).toBe(false);
    expect(openCodeNativeModeAllows(undefined, 'edit')).toBe(false);
  });
});
