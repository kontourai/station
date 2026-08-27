import { describe, expect, test } from 'vitest';
import {
  TENANT_EXECUTION_CONTEXT_OPERATION,
  TENANT_EXECUTION_CONTEXT_OUTCOME,
  TENANT_EXECUTION_CONTEXT_REASON,
  TENANT_EXECUTION_CONTEXT_SOURCE,
  tenantExecutionContextAttributes,
} from '../metrics.js';

describe('tenant execution-context telemetry contract', () => {
  test('uses only the closed, content-free propagation vocabulary', () => {
    expect(TENANT_EXECUTION_CONTEXT_OPERATION).toEqual([
      'bind',
      'dispatch',
      'start',
      'continue',
      'relay',
      'station_control',
      'background',
    ]);
    expect(TENANT_EXECUTION_CONTEXT_SOURCE).toEqual([
      'none',
      'request',
      'session',
      'operator',
      'aggregate',
    ]);
    expect(TENANT_EXECUTION_CONTEXT_OUTCOME).toEqual([
      'accepted',
      'rejected',
      'skipped',
    ]);
    expect(TENANT_EXECUTION_CONTEXT_REASON).toEqual([
      'none',
      'missing',
      'unknown',
      'mismatch',
      'aggregate_safe',
      'personal_mode',
    ]);
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
