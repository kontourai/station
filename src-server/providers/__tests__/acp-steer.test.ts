import { describe, expect, test } from 'vitest';
import {
  acpInterjectParams,
  acpSessionSteerParams,
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

describe('ACP steer wire params', () => {
  test('Kiro wraps the text the way kiro-cli _session/steer expects', () => {
    expect(acpSessionSteerParams('sess-1', 'go left')).toEqual({
      sessionId: 'sess-1',
      message: '<user_message>\ngo left\n</user_message>',
    });
  });

  test('Grok interject is { sessionId, text }, not content blocks', () => {
    expect(acpInterjectParams('sess-1', 'course correct')).toEqual({
      sessionId: 'sess-1',
      text: 'course correct',
    });
  });

  test('JSON-RPC method-not-found is the native-miss signal', () => {
    expect(isAcpMethodNotFound({ code: -32601, message: 'nope' })).toBe(true);
    expect(isAcpMethodNotFound(new Error('Method not found'))).toBe(true);
    expect(isAcpMethodNotFound(new Error('Internal error'))).toBe(false);
  });
});
