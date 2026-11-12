import { describe, expect, it } from 'vitest';
import {
  dependentsOfConnection,
  projectConnectionUsedBy,
} from '../connection-used-by';

describe('projectConnectionUsedBy', () => {
  it('lists each explicit binding with the slug to open, never a name match', () => {
    const usedBy = projectConnectionUsedBy({
      agents: [
        {
          slug: 'reviewer',
          name: 'Reviewer',
          execution: {
            agentConnectionId: 'codex-work',
            modelConnectionId: 'ollama-local',
          },
          tools: { mcpServers: ['github', 'github', 'linear'] },
        },
        // Named like the engine but bound to nothing: not a dependent.
        { slug: 'codex-work-helper', name: 'codex-work' },
      ],
      projects: [
        {
          slug: 'site',
          name: 'Site',
          defaultProviderId: 'ollama-local',
          defaultModel: 'llama3',
          defaultEmbeddingProviderId: 'openai-embed',
          toolDefaults: { mcpServers: ['linear'] },
        },
      ],
    });
    expect(usedBy.dependents).toEqual([
      {
        connectionId: 'codex-work',
        kind: 'agent',
        slug: 'reviewer',
        name: 'Reviewer',
        via: 'engine',
      },
      {
        connectionId: 'ollama-local',
        kind: 'agent',
        slug: 'reviewer',
        name: 'Reviewer',
        via: 'model',
      },
      {
        connectionId: 'github',
        kind: 'agent',
        slug: 'reviewer',
        name: 'Reviewer',
        via: 'tool-server',
      },
      {
        connectionId: 'linear',
        kind: 'agent',
        slug: 'reviewer',
        name: 'Reviewer',
        via: 'tool-server',
      },
      {
        connectionId: 'ollama-local',
        kind: 'project',
        slug: 'site',
        name: 'Site',
        via: 'project-default-model',
      },
      {
        connectionId: 'openai-embed',
        kind: 'project',
        slug: 'site',
        name: 'Site',
        via: 'project-embedding',
      },
      {
        connectionId: 'linear',
        kind: 'project',
        slug: 'site',
        name: 'Site',
        via: 'project-tools',
      },
    ]);
    expect(
      dependentsOfConnection(usedBy, 'codex-work').map((d) => d.slug),
    ).toEqual(['reviewer']);
  });

  it('counts a Project default provider only with a default model beside it', () => {
    const usedBy = projectConnectionUsedBy({
      agents: [],
      projects: [
        { slug: 'a', defaultProviderId: 'ollama-local' },
        { slug: 'b', defaultProviderId: 'ollama-local', defaultModel: ' ' },
      ],
    });
    expect(usedBy.dependents).toEqual([]);
  });

  it('ignores blank and null ids and falls back to the slug for a name', () => {
    const usedBy = projectConnectionUsedBy({
      agents: [
        {
          slug: 'plain',
          execution: { agentConnectionId: ' ', modelConnectionId: null },
          tools: { mcpServers: ['', 'docs'] },
        },
      ],
      projects: [],
    });
    expect(usedBy.dependents).toEqual([
      {
        connectionId: 'docs',
        kind: 'agent',
        slug: 'plain',
        name: 'plain',
        via: 'tool-server',
      },
    ]);
  });
});
