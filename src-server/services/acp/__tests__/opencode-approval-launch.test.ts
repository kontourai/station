import { describe, expect, test } from 'vitest';
import {
  OPENCODE_CONFIG_CONTENT_ENV,
  stationOpenCodeApprovalConfig,
  withStationOpenCodeApprovalConfig,
} from '../opencode-approval-launch.js';

/**
 * #3290: the inline configuration Station launches OpenCode with. The
 * process-level proof that it reaches the engine, and that the engine then
 * asks, is `providers/__tests__/acp-approval-mode.process.test.ts`.
 */
function launched(env: NodeJS.ProcessEnv) {
  return JSON.parse(
    withStationOpenCodeApprovalConfig(env)[OPENCODE_CONFIG_CONTENT_ENV] ?? '',
  );
}

describe('withStationOpenCodeApprovalConfig', () => {
  test('without an inherited inline configuration it carries only Station rules', () => {
    expect(launched({ PATH: '/bin' })).toEqual(stationOpenCodeApprovalConfig());
  });

  test('the rules ask before every action that is not a read, and plan keeps edits denied', () => {
    const { agent } = stationOpenCodeApprovalConfig() as {
      agent: Record<string, { permission: Record<string, unknown> }>;
    };
    expect(agent.build?.permission).toEqual({
      bash: 'ask',
      edit: 'ask',
      webfetch: 'ask',
      websearch: 'ask',
      codesearch: 'ask',
      external_directory: 'ask',
      '*_*': 'ask',
      task: 'deny',
    });
    expect(agent.plan?.permission).toEqual({
      ...agent.build?.permission,
      edit: { '*': 'deny', '.opencode/plans/*.md': 'allow' },
    });
    // Reads are left to OpenCode's defaults and the user's own rules.
    expect(agent.build?.permission).not.toHaveProperty('read');
  });

  test("the user's inline configuration is kept: other keys, other agents and build's other settings", () => {
    const content = launched({
      [OPENCODE_CONFIG_CONTENT_ENV]: JSON.stringify({
        model: 'mine/model',
        provider: { mine: { name: 'Mine' } },
        agent: {
          reviewer: { mode: 'primary', prompt: 'Review.' },
          build: {
            temperature: 0.2,
            permission: { bash: { 'git *': 'allow' }, lsp: 'deny' },
          },
        },
      }),
    });
    expect(content.model).toBe('mine/model');
    expect(content.provider).toEqual({ mine: { name: 'Mine' } });
    expect(content.agent.reviewer).toEqual({
      mode: 'primary',
      prompt: 'Review.',
    });
    expect(content.agent.build.temperature).toBe(0.2);
    // A rule Station sets replaces the user's for that action ...
    expect(content.agent.build.permission.bash).toBe('ask');
    // ... and one it does not set is left alone.
    expect(content.agent.build.permission.lsp).toBe('deny');
  });

  test('JSONC, which OpenCode accepts there, is read', () => {
    const content = launched({
      [OPENCODE_CONFIG_CONTENT_ENV]:
        '{\n  // mine\n  "model": "mine/model",\n}',
    });
    expect(content.model).toBe('mine/model');
    expect(content.agent.build.permission.bash).toBe('ask');
  });

  test('an inherited value that is not a JSON object refuses the launch instead of being replaced', () => {
    for (const inherited of ['not json', '[1,2]', '"x"']) {
      expect(() =>
        withStationOpenCodeApprovalConfig({
          [OPENCODE_CONFIG_CONTENT_ENV]: inherited,
        }),
      ).toThrow(/is not a JSON object/);
    }
  });

  test('the environment passed in is not changed', () => {
    const env = { [OPENCODE_CONFIG_CONTENT_ENV]: '{"model":"m"}', PATH: '/b' };
    const next = withStationOpenCodeApprovalConfig(env);
    expect(env[OPENCODE_CONFIG_CONTENT_ENV]).toBe('{"model":"m"}');
    expect(next.PATH).toBe('/b');
  });
});
