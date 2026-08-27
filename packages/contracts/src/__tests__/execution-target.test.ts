import { describe, expect, it } from 'vitest';
import { agentId, engineConnectionId } from '../agent-identity.js';
import {
  EXECUTION_RESOLUTION_RECEIPT_SCHEMA_VERSION,
  type ExecutionResolutionReceipt,
  type ExecutionTarget,
  environmentId,
} from '../execution-target.js';

describe('execution target contract', () => {
  it('addresses execution through Environment, Agent, model, and workspace only', () => {
    const target = {
      environment: { kind: 'saved', id: environmentId('env-media') },
      agent: agentId('codex'),
      model: {
        override: 'gpt-5.6-codex',
        options: { reasoningEffort: 'high' },
      },
      workspace: {
        kind: 'project',
        projectSlug: 'station',
        cwd: '/srv/station',
      },
    } satisfies ExecutionTarget;

    expect(target.environment).toEqual({
      kind: 'saved',
      id: 'env-media',
    });
    expect(Object.keys(target).sort()).toEqual([
      'agent',
      'environment',
      'model',
      'workspace',
    ]);
  });

  it('supports the current Environment and an explicit target-side directory', () => {
    const target = {
      environment: { kind: 'current' },
      agent: agentId('station'),
      workspace: { kind: 'directory', cwd: '/work/repository' },
    } satisfies ExecutionTarget;

    expect(target).toEqual({
      environment: { kind: 'current' },
      agent: 'station',
      workspace: { kind: 'directory', cwd: '/work/repository' },
    });
  });

  it('brands non-empty opaque Environment identities', () => {
    expect(environmentId('  71b450c9-1440-4b15-86b1-b0e28e6d347f  ')).toBe(
      '71b450c9-1440-4b15-86b1-b0e28e6d347f',
    );
    expect(() => environmentId('  ')).toThrow('must not be empty');
  });

  it('records the server-resolved binding without access or credential state', () => {
    const receipt = {
      schemaVersion: EXECUTION_RESOLUTION_RECEIPT_SCHEMA_VERSION,
      resolvedAt: '2026-08-01T22:00:00.000Z',
      environmentId: environmentId('env-media'),
      agentId: agentId('codex'),
      engine: {
        kind: 'connection',
        connectionId: engineConnectionId('codex'),
      },
      provider: 'codex',
      modelLaunchPlan: {
        kind: 'engine-selected',
        evidence: 'adapter-declared',
      },
      workspace: {
        kind: 'project',
        projectSlug: 'station',
        cwd: '/srv/station',
        workspaceIsolation: { mode: 'shared' },
      },
    } satisfies ExecutionResolutionReceipt;

    expect(receipt.schemaVersion).toBe('station.execution-resolution/v1');
    expect(Object.keys(receipt)).not.toEqual(
      expect.arrayContaining([
        'apiBase',
        'connection',
        'credential',
        'endpoint',
        'ssh',
        'transport',
      ]),
    );
  });

  it('represents the built-in Station engine without inventing a connection identity', () => {
    const receipt = {
      schemaVersion: EXECUTION_RESOLUTION_RECEIPT_SCHEMA_VERSION,
      resolvedAt: '2026-08-01T22:00:00.000Z',
      environmentId: environmentId('env-local'),
      agentId: agentId('station'),
      engine: { kind: 'station' },
      provider: 'bedrock',
      modelLaunchPlan: {
        kind: 'station-resolved',
        modelConnectionId: 'bedrock',
        modelId: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
        evidence: 'catalog-accepted',
      },
    } satisfies ExecutionResolutionReceipt;

    expect(receipt.engine).toEqual({ kind: 'station' });
    expect(Object.keys(receipt)).not.toContain('engineConnectionId');
  });
});
