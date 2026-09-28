import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import { describe, expect, it } from 'vitest';
import {
  findModelConnectionById,
  getKnowledgeInventory,
} from '../views/connectionInventory';

describe('connectionInventory', () => {
  it('prefers enabled knowledge connections and resolves model ids directly', () => {
    const connections: ConnectionConfig[] = [
      {
        id: 'lancedb-disabled',
        kind: 'model' as const,
        type: 'lancedb',
        name: 'Disabled DB',
        enabled: false,
        status: 'disabled',
        capabilities: ['vectordb'],
        config: {},
        prerequisites: [],
      },
      {
        id: 'lancedb-enabled',
        kind: 'model' as const,
        type: 'lancedb',
        name: 'Enabled DB',
        enabled: true,
        status: 'ready',
        capabilities: ['vectordb'],
        config: {},
        prerequisites: [],
      },
      {
        id: 'ollama-local',
        kind: 'model' as const,
        type: 'ollama',
        name: 'Ollama',
        enabled: true,
        status: 'ready',
        capabilities: ['llm', 'embedding'],
        config: {},
        prerequisites: [],
      },
    ];

    const inventory = getKnowledgeInventory(connections);
    expect(inventory.vectorDb?.id).toBe('lancedb-enabled');
    expect(inventory.embeddingProvider?.id).toBe('ollama-local');
    expect(findModelConnectionById(connections, 'lancedb-disabled')?.name).toBe(
      'Disabled DB',
    );
  });
});
