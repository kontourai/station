/**
 * The Kiro-parity bindings' own rules, on the recorded kiro-cli handshakes:
 * each route, rewind, fork and projection applies only where the live
 * handshake backs it, and each parser refuses what it cannot show.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ResolvedAgentDefinition } from '@kontourai/station-contracts/provider';
import { describe, expect, test } from 'vitest';
import type { InitializeResult } from '../../services/acp/acp-process.js';
import {
  kiroCustomAgentsMeta,
  kiroProjectedModeApplied,
} from '../adapters/acp-agent-projection.js';
import {
  acpCommandAnswer,
  acpCommandUnsupported,
  acpDeclaredCommands,
  readAcpSlashCommand,
  resolveAcpCommandRoute,
} from '../adapters/acp-command-routes.js';
import {
  elicitationReply,
  KIRO_USER_INPUT_DECLINED_ANSWER,
  KIRO_USER_INPUT_NO_PERSON_ANSWER,
  kiroUserInputReply,
  readCoreElicitation,
  readKiroMcpElicitation,
  readKiroOpenExternalUrl,
  readKiroUserInput,
} from '../adapters/acp-input-requests.js';
import {
  acpSessionContinuity,
  readAcpRewindAnswer,
  readAcpUserMessageId,
  resolveAcpMcpReconnect,
} from '../adapters/acp-session-actions.js';
import {
  applyAcpEffort,
  findAcpEffortConfigOption,
} from '../adapters/acp-session-mode.js';
import { resolveAcpSteerChannel } from '../adapters/acp-steer.js';
import { acpTerminalShellType } from '../adapters/acp-terminal-facts.js';

const recorded = (name: string) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          `./fixtures/acp-scripted-profiles/${name}.json`,
          import.meta.url,
        ),
      ),
      'utf8',
    ),
  ) as {
    initialize: InitializeResult;
    sessionNew: { modes: unknown; configOptions: unknown[] };
  };
const v3 = recorded('kiro-v3');
const v2 = recorded('kiro-v2');
const requester = { engineName: 'Kiro' };

describe('command routes', () => {
  test('a declared method routes its command; the same name on another engine is prompt text', () => {
    const context = resolveAcpCommandRoute(v3.initialize, {
      name: 'context',
      args: '',
    });
    expect(context.route).toMatchObject({
      kind: 'engine-request',
      method: '_kiro/session/context',
      basis: 'declared',
    });
    expect(context.params?.('s1')).toEqual({
      sessionId: 's1',
      subcommand: 'show',
    });
    expect(
      resolveAcpCommandRoute(v2.initialize, { name: 'settings', args: '' })
        .route,
    ).toEqual({ kind: 'prompt-text' });
  });

  test('memory routes only list and get; a write is refused, never sent', () => {
    expect(
      resolveAcpCommandRoute(v3.initialize, { name: 'memory', args: '' }).route,
    ).toMatchObject({ method: '_kiro/memory/list' });
    const get = resolveAcpCommandRoute(v3.initialize, {
      name: 'memory',
      args: 'get m-1',
    });
    expect(get.params?.('s1')).toEqual({ sessionId: 's1', id: 'm-1' });
    for (const args of ['create note', 'delete m-1', 'get']) {
      const refused = resolveAcpCommandRoute(v3.initialize, {
        name: 'memory',
        args,
      });
      expect(refused.params).toBeUndefined();
      expect(refused.refusal).toMatch(/read-only forms of \/memory/);
    }
  });

  test('only read-only subcommands route; trust, context and knowledge changes are refused', () => {
    // kiro-cli (v2): `/tools trust-all` would stop it asking permission.
    const tools = resolveAcpCommandRoute(v2.initialize, {
      name: 'tools',
      args: '',
    });
    expect(tools.route).toMatchObject({
      method: '_kiro.dev/commands/execute',
    });
    expect(tools.refusal).toBeUndefined();
    for (const [name, args] of [
      ['tools', 'trust-all'],
      ['tools', 'trust fs_write'],
      ['tools', 'reset'],
      ['knowledge', 'add notes ./docs'],
      ['knowledge', 'clear'],
      ['context', 'add src/**'],
      ['context', 'rm src/**'],
      ['context', 'clear'],
    ] as const) {
      const refused = resolveAcpCommandRoute(v2.initialize, { name, args });
      expect(refused.params, `${name} ${args}`).toBeUndefined();
      expect(refused.refusal, `${name} ${args}`).toContain(`/${name}`);
    }
    // The agent service (v3): `/context add` and `/knowledge remove` too.
    for (const [name, args] of [
      ['context', 'add x'],
      ['knowledge', 'remove kb-1'],
    ] as const) {
      const refused = resolveAcpCommandRoute(v3.initialize, { name, args });
      expect(refused.params).toBeUndefined();
      expect(refused.refusal).toBeDefined();
    }
    expect(
      resolveAcpCommandRoute(v3.initialize, {
        name: 'context',
        args: 'show',
      }).params?.('s1'),
    ).toEqual({ sessionId: 's1', subcommand: 'show' });
    // A command no entry routes on this session is still prompt text.
    expect(
      resolveAcpCommandRoute(v2.initialize, { name: 'plan', args: 'x' }),
    ).toEqual({ route: { kind: 'prompt-text' } });
  });

  test('a mutating form is refused whatever its case, extra words, or route table', () => {
    for (const [handshake, name, args] of [
      // Case variants of the command name or subcommand.
      [v2.initialize, 'TOOLS', 'trust-all'],
      [v2.initialize, 'Tools', 'TRUST-ALL'],
      // KAS routes no `tools`, but the engine may still run it as text.
      [v3.initialize, 'tools', 'trust-all'],
      [v3.initialize, 'TOOLS', 'Trust-All'],
      [v3.initialize, 'knowledge', 'clear'],
      // A read-only subcommand followed by more words.
      [v2.initialize, 'tools', 'schema trust-all'],
      [v2.initialize, 'tools', 'schema\n/tools trust-all'],
      [v2.initialize, 'context', 'show add foo'],
      [v2.initialize, 'knowledge', 'status clear'],
    ] as const) {
      const refused = resolveAcpCommandRoute(handshake, { name, args });
      expect(refused.params, `${name} ${args}`).toBeUndefined();
      expect(refused.refusal, `${name} ${args}`).toBeDefined();
    }
    // The read-only form still routes in any case.
    expect(
      resolveAcpCommandRoute(v2.initialize, { name: 'TOOLS', args: '' }).params,
    ).toBeDefined();
    // A non-Kiro engine's `/tools trust-all` is its own prompt text.
    expect(
      resolveAcpCommandRoute(
        { agentInfo: { name: 'Other Agent', version: '1' } } as never,
        { name: 'tools', args: 'trust-all' },
      ),
    ).toEqual({ route: { kind: 'prompt-text' } });
  });

  test('settings sends the observer the engine requires', () => {
    expect(
      resolveAcpCommandRoute(v3.initialize, {
        name: 'settings',
        args: '',
      }).params?.('s1'),
    ).toEqual({ observer: 'session', sessionId: 's1' });
  });

  test('kiro-cli runs only reviewed commands over commands/execute, keyed on its own name', () => {
    expect(
      resolveAcpCommandRoute(v2.initialize, { name: 'help', args: '' }).route,
    ).toMatchObject({
      method: '_kiro.dev/commands/execute',
      basis: 'undeclared-engine',
    });
    for (const name of ['quit', 'clear', 'model', 'agent'])
      expect(
        resolveAcpCommandRoute(v2.initialize, { name, args: '' }).route,
      ).toEqual({ kind: 'prompt-text' });
    // The agent service names itself differently and refuses the verb.
    expect(
      resolveAcpCommandRoute(v3.initialize, { name: 'help', args: '' }).route,
    ).toEqual({ kind: 'prompt-text' });
  });

  test('declared commands are offered with their routes', () => {
    expect(acpDeclaredCommands(v3.initialize).map(({ name }) => name)).toEqual([
      'compact',
      'context',
      'knowledge',
      'code',
      'memory',
      'config-template',
      'permissions',
      'settings',
      'export',
    ]);
    expect(acpDeclaredCommands(v2.initialize)).toEqual([]);
  });

  test('a slash command is read only from the whole input', () => {
    expect(readAcpSlashCommand(' /context show ')).toEqual({
      name: 'context',
      args: 'show',
    });
    expect(readAcpSlashCommand('please /context')).toBeUndefined();
    expect(readAcpSlashCommand('/')).toBeUndefined();
  });

  test('answers and refusals', () => {
    expect(
      acpCommandAnswer({ success: false, message: 'not enabled' }),
    ).toEqual({ kind: 'answered', text: 'not enabled', success: false });
    expect(acpCommandAnswer(null)).toEqual({ kind: 'answered', text: '' });
    expect(acpCommandUnsupported({ code: -32601, message: 'x' })).toBe(true);
    expect(
      acpCommandUnsupported({
        code: -32700,
        message: 'Parse error',
        data: { phase: 'deserialization' },
      }),
    ).toBe(true);
    expect(acpCommandUnsupported({ code: -32603, message: 'x' })).toBe(false);
  });
});

describe('input requests', () => {
  test('userInput is one choice field taking a custom answer; no options means free text', () => {
    const read = readKiroUserInput(
      { question: 'Which?', options: [{ title: 'A' }, { title: 'A' }] },
      requester,
    );
    expect(read).toMatchObject({
      kind: 'form',
      form: {
        body: {
          fields: [
            {
              kind: 'choice',
              allowCustom: true,
              options: [{ value: 'A', label: 'A' }],
            },
          ],
        },
      },
    });
    expect(readKiroUserInput({ question: 'Why?' }, requester)).toMatchObject({
      form: { body: { fields: [{ kind: 'string', required: true }] } },
    });
    expect(readKiroUserInput({ question: '' }, requester).kind).toBe(
      'unreadable',
    );
    expect(
      readKiroUserInput({ question: 'Q', options: [{}] }, requester).kind,
    ).toBe('unreadable');
  });

  test('a userInput reply is always answered, and never reads as agreement unless given', () => {
    expect(kiroUserInputReply('accept', { answer: 'A' }, true)).toEqual({
      action: 'answered',
      answer: 'A',
    });
    expect(
      kiroUserInputReply('accept', { answer: { custom: '  mine ' } }, true),
    ).toEqual({ action: 'answered', answer: 'mine' });
    expect(kiroUserInputReply('accept', {}, true).answer).toBe(
      KIRO_USER_INPUT_DECLINED_ANSWER,
    );
    expect(kiroUserInputReply('decline', undefined, true).answer).toBe(
      KIRO_USER_INPUT_DECLINED_ANSWER,
    );
    expect(kiroUserInputReply('decline', undefined, false).answer).toBe(
      KIRO_USER_INPUT_NO_PERSON_ANSWER,
    );
    expect(kiroUserInputReply('cancel', undefined, true).answer).toBe(
      KIRO_USER_INPUT_NO_PERSON_ANSWER,
    );
  });

  test('elicitations: nested and flat forms read; links are https, user-info-free and bounded', () => {
    const form = {
      message: 'Really?',
      requestedSchema: {
        type: 'object',
        properties: { confirm: { type: 'boolean' } },
      },
    };
    expect(
      readKiroMcpElicitation({ elicitation: form }, requester),
    ).toMatchObject({ kind: 'form', form: { source: 'harness:Kiro' } });
    expect(
      readCoreElicitation({ sessionId: 's', mode: 'form', ...form }, requester)
        .kind,
    ).toBe('form');
    expect(readCoreElicitation(form, requester).kind).toBe('unreadable');
    const url = (href: string) =>
      readCoreElicitation(
        {
          sessionId: 's',
          mode: 'url',
          message: 'Sign in',
          elicitationId: 'e',
          url: href,
        },
        requester,
      ).kind;
    expect(url('https://example.com/a')).toBe('url');
    expect(url('http://example.com/a')).toBe('unreadable');
    expect(url('https://user:pw@example.com/a')).toBe('unreadable');
    expect(url(`https://example.com/${'a'.repeat(2048)}`)).toBe('unreadable');
    expect(
      readKiroOpenExternalUrl(
        { url: 'https://example.com/consent' },
        requester,
      ),
    ).toMatchObject({
      kind: 'url',
      request: { body: { purpose: 'mcp-sign-in' } },
    });
    expect(elicitationReply('accept', { confirm: true })).toEqual({
      action: 'accept',
      content: { confirm: true },
    });
    expect(elicitationReply('decline')).toEqual({ action: 'decline' });
  });
});

describe('session actions and projection', () => {
  test('rewind and native fork are this session’s observations', () => {
    expect(acpSessionContinuity(v3.initialize)).toEqual({
      fork: 'native',
      rewind: 'in-place',
    });
    expect(acpSessionContinuity(v2.initialize)).toEqual({
      fork: 'none',
      rewind: 'none',
    });
    expect(resolveAcpMcpReconnect(v3.initialize)?.method).toBe(
      '_kiro/mcp/resetServer',
    );
    expect(resolveAcpMcpReconnect(v2.initialize)).toBeUndefined();
  });

  test('steer retract is offered only where the drop is reported exactly', () => {
    expect(resolveAcpSteerChannel(v2.initialize).retractMethod).toBe(
      '_session/steer/clear',
    );
    expect(resolveAcpSteerChannel(v3.initialize).retractMethod).toBeUndefined();
  });

  test('the prompt id is read from user_message_id_assigned only', () => {
    expect(
      readAcpUserMessageId({
        sessionUpdate: 'session_info_update',
        _meta: {
          kiro: { kind: 'user_message_id_assigned', userMessageId: 'u' },
        },
      }),
    ).toBe('u');
    expect(
      readAcpUserMessageId({
        sessionUpdate: 'session_info_update',
        _meta: { kiro: { kind: 'turn_start', userMessageId: 'u' } },
      }),
    ).toBeUndefined();
  });

  test('the agent projection: no permissions, every tool, at most 50, only on the agent service', () => {
    const agent = { slug: 'a' } as ResolvedAgentDefinition;
    const meta = kiroCustomAgentsMeta(v3.initialize, [agent]);
    expect(meta).toEqual({
      meta: {
        kiro: {
          customAgents: [
            {
              id: 'station-a',
              description: 'Station agent a',
              prompt: '',
              tools: ['*'],
            },
          ],
          modeId: 'station-a',
        },
      },
    });
    expect(kiroCustomAgentsMeta(v2.initialize, [agent])).toBeUndefined();
    expect(
      kiroCustomAgentsMeta(
        v3.initialize,
        Array.from({ length: 51 }, (_, i) => ({ slug: `a${i}` }) as never),
      ),
    ).toHaveProperty('refused');
  });

  test('a mode of bundled origin is never taken as the projected agent', () => {
    const modes = (origin: string) => ({
      modes: {
        currentModeId: 'station-a',
        availableModes: [
          {
            id: 'station-a',
            _meta: {
              kiro: {
                source: 'bundled',
                resource: { source: { origin } },
              },
            },
          },
        ],
      },
    });
    expect(kiroProjectedModeApplied('station-a', modes('client'))).toEqual({
      applied: true,
    });
    expect(kiroProjectedModeApplied('station-a', modes('bundled'))).toEqual({
      applied: false,
      reason: expect.stringContaining('bundled'),
    });
  });
});

describe('rewind answer', () => {
  // The outcome keeps at most `pathsMax` paths and always the engine's own
  // count: a cut list is stated as cut, never passed off as the whole.
  const paths = (count: number) =>
    Array.from({ length: count }, (_, index) => `src/file-${index}.ts`);

  test('at the bound every path is kept', () => {
    expect(
      readAcpRewindAnswer({ success: true, affectedFiles: paths(3) }, 3),
    ).toEqual({ success: true, affectedFiles: { count: 3, paths: paths(3) } });
  });

  test('one past the bound keeps the bound and the real count', () => {
    expect(
      readAcpRewindAnswer({ success: true, affectedFiles: paths(4) }, 3),
    ).toEqual({ success: true, affectedFiles: { count: 4, paths: paths(3) } });
  });

  test('a path over 4,096 characters is left out of the list but counted', () => {
    const long = `src/${'a'.repeat(4093)}`;
    expect(long.length).toBe(4097);
    const atBound = `src/${'a'.repeat(4092)}`;
    expect(
      readAcpRewindAnswer(
        { success: true, affectedFiles: ['src/a.ts', long, atBound] },
        50,
      ),
    ).toEqual({
      success: true,
      affectedFiles: { count: 3, paths: ['src/a.ts', atBound] },
    });
  });

  test('no file list is no file claim; anything but success is a failure', () => {
    expect(readAcpRewindAnswer({ success: true }, 50)).toEqual({
      success: true,
    });
    expect(
      readAcpRewindAnswer({ success: false, message: 'still running' }, 50),
    ).toEqual({ success: false, message: 'still running' });
    expect(readAcpRewindAnswer(null, 50)).toEqual({ success: false });
  });
});

describe('effort and terminal facts', () => {
  test('effort needs a thought_level (or declared) option; the recorded v3 session has none', async () => {
    expect(findAcpEffortConfigOption(v3.sessionNew.configOptions)).toBe(
      undefined,
    );
    await expect(
      applyAcpEffort(
        { setConfigOption: async () => ({}) },
        v3.sessionNew.configOptions,
        'high',
        'kiro',
      ),
    ).rejects.toThrow(/effort option unavailable/);
    const options = [
      {
        id: 'reasoning',
        category: 'thought_level',
        currentValue: 'low',
        options: [{ value: 'low' }, { value: 'high' }],
      },
    ];
    await expect(
      applyAcpEffort(
        {
          setConfigOption: async () => ({
            configOptions: [{ ...options[0], currentValue: 'high' }],
          }),
        },
        options,
        'high',
        'kiro',
      ),
    ).resolves.toMatchObject({ configOptions: [{ currentValue: 'high' }] });
    await expect(
      applyAcpEffort(
        { setConfigOption: async () => ({ configOptions: options }) },
        options,
        'high',
        'kiro',
      ),
    ).rejects.toThrow(/unverified/);
  });

  test('the shell type names the bridge’s POSIX grammar, and nothing on Windows', () => {
    expect(acpTerminalShellType('darwin')).toEqual({ shellType: 'sh' });
    expect(acpTerminalShellType('linux')).toEqual({ shellType: 'sh' });
    expect(acpTerminalShellType('win32')).toBeUndefined();
  });
});
