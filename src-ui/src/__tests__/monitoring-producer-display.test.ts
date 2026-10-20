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

  test("display the producer value only for the row's own producer", () => {
    expect(
      displayMonitoringId(
        'producer:flow-agents-codex:codex',
        'flow-agents-codex',
      ),
    ).toBe('codex');
    // The prefix is only text: a row with no producer, or another producer,
    // keeps the raw id.
    expect(
      displayMonitoringId('producer:flow-agents-codex:codex', undefined),
    ).toBe('producer:flow-agents-codex:codex');
    expect(
      displayMonitoringId('producer:flow-agents-codex:codex', 'other'),
    ).toBe('producer:flow-agents-codex:codex');
    expect(displayMonitoringId('default', undefined)).toBe('default');
  });

  test('shorten from the un-namespaced id, whole when it is short', () => {
    expect(
      shortMonitoringId(
        'producer:flow-agents-codex:codex-session-2',
        8,
        'flow-agents-codex',
      ),
    ).toBe('codex-session-2');
    expect(
      shortMonitoringId('producer:p:0123456789abcdef0123456789abcdef', 8, 'p'),
    ).toBe('89abcdef');
    // Not the row's producer: the raw id's tail, as for any Station id.
    expect(
      shortMonitoringId(
        'producer:flow-agents-codex:codex-session-2',
        8,
        undefined,
      ),
    ).toBe('ession-2');
    expect(
      shortMonitoringId('3f2a9c1e-7b4d-4e2a-9c1e-7b4d4e2a9c1e', 8, undefined),
    ).toBe('4e2a9c1e');
  });
});
