import { describe, expect, test } from 'vitest';
import {
  OPENCODE_CONFIG_CONTENT_ENV,
  stationOpenCodeApprovalConfig,
  stationRuleKey,
  withStationOpenCodeApprovalConfig,
} from '../opencode-approval-launch.js';

/**
 * #3290: the inline configuration Station launches OpenCode with. The
 * process-level proof that it reaches the engine, and that the engine then
 * asks, is `providers/__tests__/acp-approval-mode.process.test.ts`.
 */
function launched(env: NodeJS.ProcessEnv) {
  return JSON.parse(
    withStationOpenCodeApprovalConfig(env, 'confined')[
      OPENCODE_CONFIG_CONTENT_ENV
    ] ?? '',
  );
}

describe('withStationOpenCodeApprovalConfig', () => {
  test('without an inherited inline configuration it carries only Station rules', () => {
    expect(launched({ PATH: '/bin' })).toEqual(
      stationOpenCodeApprovalConfig('confined'),
    );
  });

  test('the rules ask before every action that is not a read, and plan keeps edits denied', () => {
    const { agent } = stationOpenCodeApprovalConfig('confined') as {
      agent: Record<string, { permission: Record<string, unknown> }>;
    };
    // Each key is the permission's name with its last character as `?`, so
    // it is never a key the user's own rules already hold a position for.
    expect(agent.build?.permission).toEqual({
      'bas?': 'ask',
      'edi?': 'ask',
      'webfetc?': 'ask',
      'websearc?': 'ask',
      'codesearc?': 'ask',
      'external_director?': 'ask',
      '*_**': 'ask',
      'tas?': 'deny',
    });
    expect(agent.plan?.permission).toEqual({
      ...agent.build?.permission,
      'edi?': { '*': 'deny', '.opencode/plans/*.md': 'allow' },
    });
    // Reads are left to OpenCode's defaults and the user's own rules.
    expect(Object.keys(agent.build?.permission ?? {})).not.toContain('rea?');
    expect(stationRuleKey('bash')).toBe('bas?');
    expect(stationRuleKey('*')).toBe('*?');
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
    // The user's rules stay, and Station's come after every one of them, so
    // OpenCode (last match wins) evaluates Station's last.
    const keys = Object.keys(content.agent.build.permission);
    expect(keys.slice(0, 2)).toEqual(['bash', 'lsp']);
    expect(keys.indexOf('bas?')).toBeGreaterThan(keys.indexOf('lsp'));
    expect(content.agent.build.permission.lsp).toBe('deny');
  });

  test('JSONC, which OpenCode accepts there, is read', () => {
    const content = launched({
      [OPENCODE_CONFIG_CONTENT_ENV]:
        '{\n  // mine\n  "model": "mine/model",\n}',
    });
    expect(content.model).toBe('mine/model');
    expect(content.agent.build.permission['bas?']).toBe('ask');
  });

  test("a key the user's inline configuration already has moves after the user's other keys", () => {
    const content = launched({
      [OPENCODE_CONFIG_CONTENT_ENV]: JSON.stringify({
        agent: { build: { permission: { 'edi?': 'allow', '*': 'allow' } } },
      }),
    });
    const keys = Object.keys(content.agent.build.permission);
    expect(keys.indexOf('edi?')).toBeGreaterThan(keys.indexOf('*'));
    expect(content.agent.build.permission['edi?']).toBe('ask');
  });

  test('an unquoted {env:NAME} token is substituted as OpenCode does, instead of refusing the launch', () => {
    const content = launched({
      MY_MODEL_LIMIT: '4096',
      [OPENCODE_CONFIG_CONTENT_ENV]: '{"limit": {env:MY_MODEL_LIMIT}}',
    });
    expect(content.limit).toBe(4096);
  });

  test('default_agent is pinned to build, over a user or project choice', () => {
    const content = launched({
      [OPENCODE_CONFIG_CONTENT_ENV]: JSON.stringify({
        default_agent: 'helper',
      }),
    });
    expect(content.default_agent).toBe('build');
  });

  test('an inherited value that is not a JSON object refuses the launch instead of being replaced', () => {
    for (const inherited of ['not json', '[1,2]', '"x"']) {
      expect(() =>
        withStationOpenCodeApprovalConfig(
          { [OPENCODE_CONFIG_CONTENT_ENV]: inherited },
          'confined',
        ),
      ).toThrow(/is not a JSON object/);
    }
  });

  test('the environment passed in is not changed', () => {
    const env = { [OPENCODE_CONFIG_CONTENT_ENV]: '{"model":"m"}', PATH: '/b' };
    const next = withStationOpenCodeApprovalConfig(env, 'confined');
    expect(env[OPENCODE_CONFIG_CONTENT_ENV]).toBe('{"model":"m"}');
    expect(next.PATH).toBe('/b');
  });

  test('#3290 full access: nothing asks, and only the built-in subagents may start, with rules that cannot ask', () => {
    const { agent } = stationOpenCodeApprovalConfig('full') as {
      agent: Record<string, { permission: Record<string, unknown> }>;
    };
    expect(agent.build?.permission).toEqual({
      '*?': 'allow',
      // A child session inherits its parent's external_directory rules.
      'external_director?': 'allow',
      'tas?': { '*': 'deny', general: 'allow', explore: 'allow' },
    });
    // Plan still blocks edits and, as OpenCode's own plan does, `general`.
    expect(agent.plan?.permission).toMatchObject({
      '*?': 'allow',
      'external_director?': 'allow',
      'edi?': { '*': 'deny', '.opencode/plans/*.md': 'allow' },
      'tas?': { '*': 'deny', explore: 'allow' },
    });
    // general: no question (it would ask a person) and no further subagent
    // but explore.
    expect(agent.general?.permission).toEqual({
      '*?': 'allow',
      'questio?': 'deny',
      'tas?': { '*': 'deny', explore: 'allow' },
    });
    // explore stays read-only: no blanket allow, but no tool it has can ask.
    expect(agent.explore?.permission).not.toHaveProperty('*?');
    expect(agent.explore?.permission).toMatchObject({
      'rea?': 'allow',
      'bas?': 'allow',
      'external_director?': 'allow',
      'doom_loo?': 'allow',
    });
    expect(Object.values(agent.explore?.permission ?? {})).not.toContain('ask');
  });

  test('the confined floor starts no subagent', () => {
    const { agent } = stationOpenCodeApprovalConfig('confined') as {
      agent: Record<string, { permission: Record<string, unknown> }>;
    };
    expect(agent.build?.permission['tas?']).toBe('deny');
    expect(agent.plan?.permission['tas?']).toBe('deny');
    expect(agent).not.toHaveProperty('general');
  });
});
