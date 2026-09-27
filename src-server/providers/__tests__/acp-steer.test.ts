import { describe, expect, test } from 'vitest';
import {
  isAcpMethodNotFound,
  resolveAcpSteerChannel,
} from '../adapters/acp-steer.js';

describe('resolveAcpSteerChannel', () => {
  test('Grok uses the native interject extension method', () => {
    expect(resolveAcpSteerChannel({ command: 'grok' })).toBe('interject');
    expect(
      resolveAcpSteerChannel({ command: 'grok', args: ['agent', 'stdio'] }),
    ).toBe('interject');
    expect(resolveAcpSteerChannel({ agentName: 'xAI Grok' })).toBe('interject');
  });

  test('Kiro uses _session/steer', () => {
    expect(resolveAcpSteerChannel({ command: 'kiro-cli' })).toBe(
      'session-steer',
    );
    expect(resolveAcpSteerChannel({ agentName: 'Kiro' })).toBe('session-steer');
  });

  test('unknown ACP falls back to cancel-and-reprompt', () => {
    expect(resolveAcpSteerChannel({ command: 'other-cli' })).toBe(
      'cancel-reprompt',
    );
    expect(resolveAcpSteerChannel({})).toBe('cancel-reprompt');
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
