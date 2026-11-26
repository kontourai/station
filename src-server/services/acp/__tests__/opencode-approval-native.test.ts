import { describe, expect, test } from 'vitest';
import { loadOpenCodeFixture } from '../../../providers/__tests__/opencode-serve-replay.js';
import type { AcpAppliedApprovalMode } from '../../../providers/adapters/acp-approval-mode.js';
import {
  evaluateOpenCodeRules,
  OPENCODE_SESSION_MOVE_ACTION,
  type OpenCodeNativeRule,
  openCodeGrantCovers,
  openCodeNativeApprovalRules,
  openCodeNativeAskAnswer,
  openCodeNativeModeAllows,
  openCodeNativePersistenceTarget,
  openCodeSavedApprovalOverrides,
} from '../opencode-approval-native.js';
import { openCodeNativeAskNeedsPerson } from '../opencode-project-config.js';

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
    // Starting a subagent asks too, and Station rejects it: delegated child
    // work stays out of a governed session.
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
        configNeedsPerson: () => false,
      }),
    ).toBe('reject');
  });

  test("Station's rules ask for every governed action, deny only Code Mode's session move, and are none at full access", () => {
    expect(openCodeNativeApprovalRules('full')).toEqual([]);
    const confined = openCodeNativeApprovalRules('confined');
    expect(confined.length).toBeGreaterThan(0);
    // The move tool is denied last, so no earlier `*_*` ask outranks it.
    expect(confined.at(-1)).toEqual({
      action: 'opencode_session_move',
      resource: '*',
      effect: 'deny',
    });
    expect(OPENCODE_SESSION_MOVE_ACTION).toBe('opencode_session_move');
    expect(confined.slice(0, -1).every((rule) => rule.effect === 'ask')).toBe(
      true,
    );
    // No governed action is denied by it.
    for (const action of ['shell', 'edit', 'webfetch', 'station_echo'])
      expect(
        evaluateOpenCodeRules({ action, resources: ['x'] }, confined, []),
      ).toBe('ask');
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
    // The capture's first lookup can be the booting server's 404.
    const record = loadOpenCodeFixture('plan-deny').find(
      (line) => line.path === '/api/agent/plan' && line.status === 200,
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
      configNeedsPerson: () =>
        openCodeNativeAskNeedsPerson(
          request,
          '/replay/proj',
          {},
          '/replay/home',
        ),
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
    // and Auto asks too: the plan file is under `.opencode/`, OpenCode
    // configuration no mode below full access answers (as on ACP).
    const planFile = {
      action: 'edit',
      resources: ['{HOME}/.opencode/plan/next.md'],
    };
    expect(outcome(plan, 'never', planFile)).toBe('runs');
    expect(outcome(plan, 'ask', planFile)).toBe('asks');
    expect(outcome(plan, 'auto', planFile)).toBe('asks');
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
        configNeedsPerson: () => false,
      }),
    ).toBe('reject');
    // Without the confined rules governing, Station keeps no deny of its own.
    expect(
      openCodeNativeAskAnswer({
        mode: 'never',
        agentRules: undefined,
        request: edit,
        granted: false,
        configNeedsPerson: () => true,
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

  test('an OpenCode configuration edit goes to the person whatever grant or mode below full access would answer it', () => {
    const configEdit = { action: 'edit', resources: ['opencode.json'] };
    for (const mode of ['auto', 'ask', undefined] as const)
      for (const granted of [true, false])
        expect(
          openCodeNativeAskAnswer({
            mode,
            agentRules: [],
            request: configEdit,
            granted,
            configNeedsPerson: () => true,
          }),
          `${mode} ${granted}`,
        ).toBe('person');
    // Host full access is full: the guard is not consulted.
    expect(
      openCodeNativeAskAnswer({
        mode: 'never',
        agentRules: undefined,
        request: configEdit,
        granted: false,
        configNeedsPerson: () => true,
      }),
    ).toBe('once');
    // A kept deny still comes first.
    expect(
      openCodeNativeAskAnswer({
        mode: 'auto',
        agentRules: [{ action: 'edit', resource: '*', effect: 'deny' }],
        request: configEdit,
        granted: true,
        configNeedsPerson: () => true,
      }),
    ).toBe('reject');
  });

  describe('openCodeNativeAskNeedsPerson', () => {
    const cwd = '/replay/proj';
    const env = { XDG_CONFIG_HOME: '/replay/home/.config' };
    const home = '/replay/home';
    const needs = (action: string, resources: string[]) =>
      openCodeNativeAskNeedsPerson({ action, resources }, cwd, env, home);

    test('edits of OpenCode configuration, in the project or global, or outside the project', () => {
      expect(needs('edit', ['opencode.json'])).toBe(true);
      expect(needs('edit', ['opencode.jsonc'])).toBe(true);
      expect(needs('edit', ['.opencode/plugin/x.ts'])).toBe(true);
      expect(needs('edit', ['sub/.opencode/tool/t.ts'])).toBe(true);
      expect(needs('edit', ['/replay/proj/opencode.json'])).toBe(true);
      expect(
        needs('edit', ['/replay/home/.config/opencode/opencode.json']),
      ).toBe(true);
      expect(needs('edit', ['/elsewhere/file.txt'])).toBe(true);
      // One config target among ordinary ones is enough.
      expect(needs('edit', ['src/a.ts', 'opencode.json'])).toBe(true);
    });

    test('a target Station cannot place goes to the person', () => {
      expect(needs('edit', [])).toBe(true);
      expect(needs('edit', ['../opencode.json'])).toBe(true);
      expect(needs('edit', ['./opencode.json'])).toBe(true);
      expect(needs('edit', ['.'])).toBe(true);
    });

    test("ordinary project edits are not the guard's", () => {
      expect(needs('edit', ['src/app.ts'])).toBe(false);
      expect(needs('edit', ['edit-me.txt', '/replay/proj/docs/x.md'])).toBe(
        false,
      );
    });

    test('an outside directory that is or holds OpenCode configuration goes to the person', () => {
      expect(
        needs('external_directory', ['/replay/home/.config/opencode/*']),
      ).toBe(true);
      expect(needs('external_directory', ['/replay/home/*'])).toBe(true);
      expect(needs('external_directory', ['/other/.opencode/*'])).toBe(true);
      expect(needs('external_directory', ['relative/*'])).toBe(true);
      expect(needs('external_directory', ['/data/shared/*'])).toBe(false);
    });

    test("other actions are not the guard's", () => {
      expect(needs('shell', ['echo opencode.json'])).toBe(false);
      expect(needs('read', ['opencode.json'])).toBe(false);
    });
  });
});

describe('openCodeNativePersistenceTarget (#4828 on the native transport)', () => {
  test('an edit ask naming an instruction or hook file, as a resource or in its metadata, is a target', () => {
    expect(
      openCodeNativePersistenceTarget({
        action: 'edit',
        resources: ['AGENTS.md'],
      }),
    ).toBe('AGENTS.md');
    expect(
      openCodeNativePersistenceTarget({
        action: 'edit',
        resources: ['notes.txt'],
        files: ['.git/hooks/pre-commit'],
      }),
    ).toBe('.git/hooks/pre-commit');
  });

  test('an ordinary edit, and any other action, is not', () => {
    expect(
      openCodeNativePersistenceTarget({ action: 'edit', resources: ['a.ts'] }),
    ).toBeUndefined();
    expect(
      openCodeNativePersistenceTarget({
        action: 'shell',
        resources: ['echo x > AGENTS.md'],
      }),
    ).toBeUndefined();
  });
});
