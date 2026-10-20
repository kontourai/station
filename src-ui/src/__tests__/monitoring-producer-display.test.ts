import { describe, expect, test } from 'vitest';
import {
  displayMonitoringId,
  parseProducerScopedId,
  shortMonitoringId,
} from '../../../src-shared/monitoring-keys';

describe('producer-namespaced monitoring ids for display', () => {
  test('parse the producer and its own value', () => {
    expect(parseProducerScopedId('producer:flow-agents-codex:codex')).toEqual({
      producer: 'flow-agents-codex',
      value: 'codex',
    });
    // The reported value may itself contain ':'.
    expect(parseProducerScopedId('producer:p:a:b')).toEqual({
      producer: 'p',
      value: 'a:b',
    });
    for (const notScoped of [
      'codex',
      'producer:',
      'producer::x',
      'producer:p:',
      undefined,
      42,
    ])
      expect(parseProducerScopedId(notScoped)).toBeUndefined();
  });

  test('display the producer value and leave Station ids alone', () => {
    expect(displayMonitoringId('producer:flow-agents-codex:codex')).toBe(
      'codex',
    );
    expect(displayMonitoringId('default')).toBe('default');
  });

  test('shorten from the un-namespaced id, whole when it is short', () => {
    expect(
      shortMonitoringId('producer:flow-agents-codex:codex-session-2', 8),
    ).toBe('codex-session-2');
    expect(
      shortMonitoringId('producer:p:0123456789abcdef0123456789abcdef', 8),
    ).toBe('89abcdef');
    // Station ids keep their existing tail form.
    expect(shortMonitoringId('3f2a9c1e-7b4d-4e2a-9c1e-7b4d4e2a9c1e', 8)).toBe(
      '4e2a9c1e',
    );
  });
});
