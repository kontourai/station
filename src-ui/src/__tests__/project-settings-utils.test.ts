import { describe, expect, test } from 'vitest';
import {
  buildProjectForm,
  buildProjectSavePayload,
  getKnowledgeTimeAgo,
  globalAgentsOnly,
} from '../views/project-settings/utils';

describe('project-settings utils', () => {
  test('buildProjectForm normalizes optional project fields', () => {
    expect(
      buildProjectForm({
        name: 'Demo',
        icon: undefined,
        description: undefined,
        defaultModel: undefined,
        workingDirectory: undefined,
        agents: undefined,
      } as any),
    ).toEqual({
      name: 'Demo',
      icon: '',
      description: '',
      defaultModel: '',
      defaultWorkspaceIsolation: 'shared',
      defaultEnvironment: { kind: 'current' },
      workingDirectory: '',
      agents: undefined,
    });
  });

  test('getKnowledgeTimeAgo formats recent durations', () => {
    const now = new Date('2026-01-01T12:00:00.000Z').getTime();
    expect(getKnowledgeTimeAgo('2026-01-01T11:59:30.000Z', now)).toBe(
      'just now',
    );
    expect(getKnowledgeTimeAgo('2026-01-01T11:00:00.000Z', now)).toBe('1h ago');
  });

  test('buildProjectSavePayload serializes the default environment and unscoped agents so updates preserve execution routing and clear saved scopes', () => {
    expect(
      buildProjectSavePayload({
        name: 'Demo',
        icon: '',
        description: '',
        defaultModel: '',
        workingDirectory: '',
        agents: undefined,
      }),
    ).toEqual({
      name: 'Demo',
      icon: '',
      description: '',
      defaultModel: '',
      defaultEnvironment: { kind: 'current' },
      workingDirectory: undefined,
      agents: null,
    });
  });

  test('globalAgentsOnly excludes project-owned agents from the availability filter list (station#1004 §3.3)', () => {
    const agents = [
      { slug: 'global-one', name: 'Global One' },
      { slug: 'owned-agent', name: 'Owned Agent', project: 'demo-project' },
      { slug: 'global-two', name: 'Global Two' },
    ];

    expect(globalAgentsOnly(agents).map((agent) => agent.slug)).toEqual([
      'global-one',
      'global-two',
    ]);
  });
});
