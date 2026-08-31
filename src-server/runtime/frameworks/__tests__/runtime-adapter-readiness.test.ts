import { engineId } from '@kontourai/station-contracts/agent-identity';
import { describe, expect, test } from 'vitest';
import {
  connectionStatusFromRuntimeReadiness,
  resolveRuntimeAdapterReadiness,
} from '../runtime-adapter-readiness';

const adapter = {
  provider: 'codex',
  metadata: {
    displayName: 'Codex Runtime',
    capabilities: ['agent-runtime'],
  },
} as any;

describe('runtime adapter readiness', () => {
  test('marks enabled adapters with required prerequisites as configured', () => {
    const readiness = resolveRuntimeAdapterReadiness({
      adapter,
      engineId: engineId('codex'),
      enabled: true,
      prerequisites: [
        {
          id: 'cli',
          name: 'CLI',
          description: 'CLI',
          status: 'installed',
          category: 'required',
        },
      ],
    });

    expect(readiness.state).toBe('configured');
    expect(readiness.ready).toBe(true);
    expect(connectionStatusFromRuntimeReadiness(readiness)).toBe('ready');
  });

  test('separates disabled, missing prerequisite, and non-chat states', () => {
    expect(
      resolveRuntimeAdapterReadiness({
        adapter,
        engineId: engineId('codex'),
        enabled: false,
        prerequisites: [],
      }).state,
    ).toBe('runtime_connection_missing');

    expect(
      resolveRuntimeAdapterReadiness({
        adapter,
        engineId: engineId('codex'),
        enabled: true,
        prerequisites: [
          {
            id: 'cli',
            name: 'CLI',
            description: 'CLI',
            status: 'missing',
            category: 'required',
          },
        ],
      }).state,
    ).toBe('unavailable_prerequisites');

    expect(
      resolveRuntimeAdapterReadiness({
        adapter: {
          ...adapter,
          metadata: { ...adapter.metadata, capabilities: ['llm'] },
        },
        engineId: engineId('model-runtime'),
        enabled: true,
        prerequisites: [],
      }).state,
    ).toBe('unusable_for_chat');
  });
});
