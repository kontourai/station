import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  isAcpMethodNotFound,
  resolveAcpSteerChannel,
} from '../adapters/acp-steer.js';

/** Reduced from live `initialize` answers recorded 2026-10-21. */
const KIRO_V2 = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true },
  agentInfo: {
    name: 'Kiro CLI Agent',
    title: 'Kiro CLI Agent',
    version: '2.33.0',
  },
};
const KIRO_V3 = {
  protocolVersion: 1,
  agentCapabilities: {
    _meta: { kiro: { extensionMethods: ['_kiro/session/compact'] } },
  },
};
const GROK = {
  protocolVersion: 1,
  agentCapabilities: { _meta: { 'x.ai/fs_notify': true } },
  _meta: { grokShell: true, agentVersion: '1.0.50' },
};

/** OpenCode 2.3.0's own `initialize` answer, from its scrubbed capture. */
function openCodeInitialize() {
  const line = readFileSync(
    new URL('./fixtures/opencode-serve-2.3.0-crossload.jsonl', import.meta.url),
    'utf8',
  )
    .split('\n')
    .filter(Boolean)
    .map((entry) => JSON.parse(entry))
    .find(
      (entry) =>
        entry.kind === 'acp' &&
        entry.dir === '<-' &&
        entry.msg.result?.protocolVersion !== undefined,
    );
  return line.msg.result;
}

describe('resolveAcpSteerChannel', () => {
  test("OpenCode 2.x's live handshake selects _session/steering, undeclared", () => {
    const handshake = openCodeInitialize();
    expect(handshake.agentInfo).toEqual({ name: 'OpenCode', version: '2.3.0' });
    expect(resolveAcpSteerChannel(handshake)).toEqual({
      channel: 'session-steering',
      methods: ['_session/steering'],
      basis: 'undeclared-engine',
    });
  });

  test('OpenCode 1.x, named the same but declaring no steering, is not matched', () => {
    const handshake = openCodeInitialize();
    const { _meta: _dropped, ...withoutMeta } = handshake;
    expect(
      resolveAcpSteerChannel({
        ...withoutMeta,
        agentInfo: { name: 'OpenCode', version: '1.18.18' },
      }),
    ).toEqual({ channel: 'cancel-reprompt', methods: [], basis: 'none' });
    // A flag that is not `{supported: true}` is not a declaration.
    expect(
      resolveAcpSteerChannel({
        ...withoutMeta,
        _meta: { steering: { supported: false } },
      }).channel,
    ).toBe('cancel-reprompt');
  });

  test('a declared native method is used whoever declares it', () => {
    expect(
      resolveAcpSteerChannel({
        agentInfo: { name: 'Acme', version: '1' },
        agentCapabilities: {
          _meta: { acme: { extensionMethods: ['_x.ai/interject'] } },
        },
      }),
    ).toEqual({
      channel: 'interject',
      methods: ['_x.ai/interject'],
      basis: 'declared',
    });
  });

  test('Antigravity, which steers with a core prompt, matches on its agentInfo name', () => {
    // agentInfo as recorded from Antigravity CLI 1.5.8 `agy acp`.
    expect(
      resolveAcpSteerChannel({
        agentInfo: { name: 'Antigravity ACP Server', version: '1.5.8' },
        agentCapabilities: {},
      }),
    ).toEqual({
      channel: 'prompt-handoff',
      methods: [],
      basis: 'undeclared-engine',
    });
    // A look-alike name is not the engine.
    expect(
      resolveAcpSteerChannel({
        agentInfo: { name: 'Antigravity ACP Server (fork)', version: '1' },
        agentCapabilities: {},
      }).channel,
    ).toBe('cancel-reprompt');
  });

  test('Kiro and Grok, which do not declare their methods, match on their own handshake', () => {
    expect(resolveAcpSteerChannel(KIRO_V2)).toMatchObject({
      channel: 'session-steer',
      basis: 'undeclared-engine',
    });
    expect(resolveAcpSteerChannel(KIRO_V3)).toMatchObject({
      channel: 'session-steer',
      basis: 'undeclared-engine',
    });
    expect(resolveAcpSteerChannel(GROK)).toEqual({
      channel: 'interject',
      methods: ['_x.ai/interject', 'x.ai/interject'],
      basis: 'undeclared-engine',
    });
  });

  test('Goose, which declares feature flags but not its methods, steers a named run', () => {
    // aaif-goose/goose v1.59.0 crates/goose/src/acp/server.rs on_initialize.
    const goose = {
      protocolVersion: 1,
      agentInfo: { name: 'goose', version: '1.59.0' },
      agentCapabilities: {
        loadSession: true,
        _meta: { goose: { recipeParameterScopes: {} } },
      },
    };
    expect(resolveAcpSteerChannel(goose)).toEqual({
      channel: 'run-steer',
      methods: ['_goose/unstable/session/steer'],
      basis: 'undeclared-engine',
      activeRun: { namespace: 'goose', key: 'activeRunId' },
    });
  });

  test('a similar name, a falsy flag or no handshake selects nothing', () => {
    const none = { channel: 'cancel-reprompt', methods: [], basis: 'none' };
    expect(
      resolveAcpSteerChannel({
        agentInfo: { name: 'Kiro CLI Agent (fork)', version: '1' },
      }),
    ).toEqual(none);
    expect(resolveAcpSteerChannel({ _meta: { grokShell: 'yes' } })).toEqual(
      none,
    );
    expect(resolveAcpSteerChannel(null)).toEqual(none);
  });
});

// The Kiro and Grok wire params are pinned through AcpAdapter.steerTurn in
// acp-adapter.test.ts.
describe('isAcpMethodNotFound', () => {
  test('JSON-RPC method-not-found is the native-miss signal', () => {
    expect(isAcpMethodNotFound({ code: -32601, message: 'nope' })).toBe(true);
    expect(isAcpMethodNotFound(new Error('Method not found'))).toBe(true);
    expect(isAcpMethodNotFound(new Error('Internal error'))).toBe(false);
  });
});

describe('the recorded Antigravity steer behind prompt-handoff', () => {
  test('the first prompt answers once the second arrives, and the work finishes under the second', () => {
    // Capture `mid-turn-steer` (Antigravity CLI 1.5.8): prompt 5 runs
    // `sleep 12`, prompt 6 is sent while it runs.
    const frames = readFileSync(
      fileURLToPath(
        new URL(
          '../../services/acp/__tests__/fixtures/antigravity-1.5.8-session-frames.jsonl',
          import.meta.url,
        ),
      ),
      'utf8',
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((frame) => frame.capture === 'mid-turn-steer');
    const at = (match: (msg: any) => boolean) =>
      frames.findIndex((frame) => match(frame.msg));
    const secondSent = at(
      (msg) => msg.method === 'session/prompt' && msg.id === 6,
    );
    const firstAnswered = at((msg) => msg.id === 5 && 'result' in msg);
    const toolDone = at(
      (msg) =>
        msg.params?.update?.sessionUpdate === 'tool_call_update' &&
        msg.params.update.status === 'completed',
    );
    const secondAnswered = at((msg) => msg.id === 6 && 'result' in msg);
    expect(
      [secondSent, firstAnswered, toolDone, secondAnswered].every(
        (index) => index >= 0,
      ),
    ).toBe(true);
    expect(secondSent).toBeLessThan(firstAnswered);
    expect(firstAnswered).toBeLessThan(toolDone);
    expect(toolDone).toBeLessThan(secondAnswered);
    expect(frames[firstAnswered].msg.result.stopReason).toBe('end_turn');
    // Separate model calls, not a running total: the second answer's input
    // is below the first's.
    expect(frames[secondAnswered].msg.result.usage.inputTokens).toBeLessThan(
      frames[firstAnswered].msg.result.usage.inputTokens,
    );
  });
});
