import { describe, expect, test } from 'vitest';
import {
  TENANT_EXECUTION_CONTEXT_OPERATION,
  TENANT_EXECUTION_CONTEXT_OUTCOME,
  TENANT_EXECUTION_CONTEXT_REASON,
  TENANT_EXECUTION_CONTEXT_SOURCE,
  tenantExecutionContextAttributes,
} from '../metrics.js';

describe('tenant execution-context telemetry contract', () => {
  test('records a value outside the closed vocabulary as the fixed sentinel, never as content', () => {
    const attributes = tenantExecutionContextAttributes({
      operation: 'tenant-alpha',
      source: 'alpha.example.test',
      outcome: { tenant: 'alpha' },
      reason: 'user-1 sent a prompt',
    } as any);

    expect(attributes).toEqual({
      operation: 'invalid',
      source: 'invalid',
      outcome: 'invalid',
      reason: 'invalid',
    });
  });

  test('passes exactly the pinned vocabulary through unchanged', () => {
    // Pinned as literals, not derived from the production arrays: a value
    // added to (or dropped from) a metric dimension is a contract change this
    // test must see.
    const vocabulary = {
      operation: [
        'bind',
        'dispatch',
        'start',
        'continue',
        'relay',
        'station_control',
        'background',
      ],
      source: ['none', 'request', 'session', 'operator', 'aggregate'],
      outcome: ['accepted', 'rejected', 'skipped'],
      reason: [
        'none',
        'missing',
        'unknown',
        'mismatch',
        'aggregate_safe',
        'personal_mode',
      ],
    } as const;
    expect({
      operation: TENANT_EXECUTION_CONTEXT_OPERATION,
      source: TENANT_EXECUTION_CONTEXT_SOURCE,
      outcome: TENANT_EXECUTION_CONTEXT_OUTCOME,
      reason: TENANT_EXECUTION_CONTEXT_REASON,
    }).toEqual(vocabulary);
    const base = {
      operation: 'bind',
      source: 'none',
      outcome: 'accepted',
      reason: 'none',
    } as const;
    for (const [dimension, values] of Object.entries(vocabulary)) {
      for (const value of values) {
        expect(
          tenantExecutionContextAttributes({ ...base, [dimension]: value }),
        ).toEqual({ ...base, [dimension]: value });
      }
    }
  });

  test('projects untrusted wider values to four bounded attributes', () => {
    const attributes = tenantExecutionContextAttributes({
      operation: 'station_control',
      source: 'session',
      outcome: 'accepted',
      reason: 'none',
      tenant: 'alpha',
      authority: 'alpha.example.test',
      host: 'alpha.example.test',
      user: 'user-1',
      session: 'thread-1',
      token: 'secret',
      prompt: 'sensitive input',
      toolArgs: { scope: 'all' },
    } as any);

    expect(attributes).toEqual({
      operation: 'station_control',
      source: 'session',
      outcome: 'accepted',
      reason: 'none',
    });
  });
});
