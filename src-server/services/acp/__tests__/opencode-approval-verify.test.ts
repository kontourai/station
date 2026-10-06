import { describe, expect, test } from 'vitest';
import {
  type OpenCodeResolvedAgent,
  type OpenCodeRule,
  verifyOpenCodeApprovalFloor,
} from '../opencode-approval-verify.js';

/**
 * #3290: Station claims to govern OpenCode only when the rules OpenCode
 * resolved (`opencode debug agent`) make Station's rules effective. These
 * rulesets have the shape OpenCode 1.18.18 prints, in evaluation order.
 */
const r = (
  permission: string,
  action: string,
  pattern = '*',
): OpenCodeRule => ({
  permission,
  pattern,
  action,
});

const STATION_CONFINED = [
  r('bas?', 'ask'),
  r('edi?', 'ask'),
  r('webfetc?', 'ask'),
  r('websearc?', 'ask'),
  r('codesearc?', 'ask'),
  r('external_director?', 'ask'),
  r('*_*', 'ask'),
  r('tas?', 'deny'),
];
const OPENCODE_DEFAULTS = [
  r('*', 'allow'),
  r('doom_loop', 'ask'),
  r('external_directory', 'ask'),
  r('read', 'allow'),
  r('read', 'ask', '*.env'),
];
const TOOL_OUTPUT = r(
  'external_directory',
  'allow',
  '/home/u/.local/share/opencode/tool-output/*',
);

function reader(agents: Record<string, OpenCodeResolvedAgent>) {
  return async (name: string) => {
    const agent = agents[name];
    if (!agent) throw new Error(`Agent ${name} not found`);
    return agent;
  };
}

const confinedPlan = {
  permission: [
    ...OPENCODE_DEFAULTS,
    ...STATION_CONFINED,
    r('edi?', 'deny'),
    r('edi?', 'allow', '.opencode/plans/*.md'),
    TOOL_OUTPUT,
  ],
};

describe('verifyOpenCodeApprovalFloor (#3290)', () => {
  test("Station's rules after OpenCode's defaults and the tool-output allow are effective", async () => {
    await expect(
      verifyOpenCodeApprovalFloor(
        'confined',
        reader({
          build: {
            permission: [
              ...OPENCODE_DEFAULTS,
              ...STATION_CONFINED,
              TOOL_OUTPUT,
            ],
          },
          plan: confinedPlan,
        }),
      ),
    ).resolves.toEqual({ ok: true });
  });

  test("a user rule evaluated after Station's lets the action run, so Station does not govern (finding 2)", async () => {
    await expect(
      verifyOpenCodeApprovalFloor(
        'confined',
        reader({
          // The user's later `*` wins over Station's `edit: ask`.
          build: {
            permission: [
              ...OPENCODE_DEFAULTS,
              r('edit', 'ask'),
              r('*', 'allow'),
            ],
          },
          plan: confinedPlan,
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      reason:
        "your OpenCode configuration overrides Station's approval rules for bash in the build agent (it would run without asking)",
    });
  });

  test('a narrower later allow (one command) is caught too, not only a catch-all', async () => {
    const result = await verifyOpenCodeApprovalFloor(
      'confined',
      reader({
        build: {
          permission: [
            ...OPENCODE_DEFAULTS,
            ...STATION_CONFINED,
            r('bash', 'allow', 'git *'),
          ],
        },
        plan: confinedPlan,
      }),
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.reason).toMatch(
      /for bash in the build agent/,
    );
  });

  test('a stricter later rule (deny) keeps Station governing', async () => {
    await expect(
      verifyOpenCodeApprovalFloor(
        'confined',
        reader({
          build: {
            permission: [
              ...OPENCODE_DEFAULTS,
              ...STATION_CONFINED,
              r('bash', 'deny', 'rm *'),
            ],
          },
          plan: confinedPlan,
        }),
      ),
    ).resolves.toEqual({ ok: true });
  });

  test('a later task allow would start an ungoverned subagent', async () => {
    const result = await verifyOpenCodeApprovalFloor(
      'confined',
      reader({
        build: {
          permission: [
            ...OPENCODE_DEFAULTS,
            ...STATION_CONFINED,
            r('task', 'allow', 'general'),
          ],
        },
        plan: confinedPlan,
      }),
    );
    expect(result.ok ? '' : result.reason).toMatch(
      /for task in the build agent \(it could start general\)/,
    );
  });

  test('an engine that cannot report its rules is not governed', async () => {
    await expect(
      verifyOpenCodeApprovalFloor('confined', async () => {
        throw new Error('unknown command: debug');
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/could not read OpenCode's resolved/),
    });
    await expect(
      verifyOpenCodeApprovalFloor(
        'confined',
        reader({ build: {}, plan: confinedPlan }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason:
        'OpenCode did not report resolved approval rules for the build agent',
    });
  });

  describe('full access', () => {
    const primary = (permitted: string[]) => ({
      permission: [
        ...OPENCODE_DEFAULTS,
        r('*?', 'allow'),
        r('external_director?', 'allow'),
        r('tas?', 'deny'),
        ...permitted.map((name) => r('tas?', 'allow', name)),
        TOOL_OUTPUT,
      ],
    });
    const general = (extra: OpenCodeRule[] = []) => ({
      permission: [
        ...OPENCODE_DEFAULTS,
        r('*?', 'allow'),
        r('questio?', 'deny'),
        r('tas?', 'deny'),
        r('tas?', 'allow', 'explore'),
        ...extra,
      ],
      tools: { bash: true, edit: true, read: true, question: true, task: true },
    });
    const explore = {
      permission: [
        r('*', 'deny'),
        r('grep', 'allow'),
        ...[
          'grep',
          'glob',
          'list',
          'bash',
          'read',
          'external_directory',
          'doom_loop',
        ].map((tool) => r(`${tool.slice(0, -1)}?`, 'allow')),
      ],
      tools: { grep: true, glob: true, read: true, bash: true },
    };

    test('only the built-in subagents, with rules that cannot ask, pass', async () => {
      await expect(
        verifyOpenCodeApprovalFloor(
          'full',
          reader({
            build: primary(['general', 'explore']),
            plan: primary(['explore']),
            general: general(),
            explore,
          }),
        ),
      ).resolves.toEqual({ ok: true });
    });

    test('a subagent rule that asks would hang the child, so full access is refused', async () => {
      const result = await verifyOpenCodeApprovalFloor(
        'full',
        reader({
          build: primary(['general', 'explore']),
          plan: primary(['explore']),
          general: general([r('bash', 'ask', 'rm *')]),
          explore,
        }),
      );
      expect(result.ok ? '' : result.reason).toMatch(
        /for bash in the general agent \(a subagent could ask and hang\)/,
      );
    });

    test("general's question must stay denied (finding 5)", async () => {
      const result = await verifyOpenCodeApprovalFloor(
        'full',
        reader({
          build: primary(['general', 'explore']),
          plan: primary(['explore']),
          general: general([r('question', 'allow')]),
          explore,
        }),
      );
      expect(result.ok ? '' : result.reason).toMatch(
        /for question in the general agent/,
      );
    });

    test("a user's own subagent allowed from build is refused", async () => {
      const result = await verifyOpenCodeApprovalFloor(
        'full',
        reader({
          build: primary(['general', 'explore', 'reviewer']),
          plan: primary(['explore']),
          general: general(),
          explore,
        }),
      );
      expect(result.ok ? '' : result.reason).toMatch(/it could start reviewer/);
    });
  });
});
