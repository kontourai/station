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

describe('resolveAcpSteerChannel', () => {
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
