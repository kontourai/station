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

  test('passes every vocabulary value through unchanged', () => {
    // A literal alongside the constant-derived rows: shrinking the vocabulary
    // cannot make this vacuous.
    expect(TENANT_EXECUTION_CONTEXT_OPERATION).toContain('station_control');
    const dimensions = [
      ['operation', TENANT_EXECUTION_CONTEXT_OPERATION],
      ['source', TENANT_EXECUTION_CONTEXT_SOURCE],
      ['outcome', TENANT_EXECUTION_CONTEXT_OUTCOME],
      ['reason', TENANT_EXECUTION_CONTEXT_REASON],
    ] as const;
    const base = {
      operation: 'bind',
      source: 'none',
      outcome: 'accepted',
      reason: 'none',
    } as const;
    for (const [dimension, vocabulary] of dimensions) {
      for (const value of vocabulary) {
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
