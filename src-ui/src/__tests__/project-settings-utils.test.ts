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
        defaultProviderId: undefined,
        workingDirectory: undefined,
        agents: undefined,
      } as any),
    ).toEqual({
      name: 'Demo',
      icon: '',
      description: '',
      defaultModel: '',
      // Empty string, not absent: the pair is what a project default needs,
      // and an `undefined` would be dropped by JSON.stringify on save, so
      // clearing the connection would never reach the server.
      defaultProviderId: '',
      // #2144 slice 2: a record with no mode has chosen NOTHING, not the
      // shared checkout. Seeding 'shared' here is what made an unrelated
      // save pin the project away from the Station default.
      defaultWorkspaceIsolation: 'inherit',
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
        defaultWorkspaceIsolation: 'inherit',
        workingDirectory: '',
        agents: undefined,
      } as never),
    ).toEqual({
      name: 'Demo',
      icon: '',
      description: '',
      defaultModel: '',
      // `null`, not absent: the route drops the override on null, and
      // JSON.stringify would drop an `undefined` and leave a previously
      // stored mode in place (#2144 slice 2).
      defaultWorkspaceIsolation: null,
      defaultEnvironment: { kind: 'current' },
      workingDirectory: undefined,
      agents: null,
    });
  });

  /**
   * The round trip the regression lived in: load a project that names no
   * workspace mode, change something unrelated, save. The payload must not
   * carry a concrete mode, or the save pins the project away from the
   * Station default nobody asked to leave.
   */
  test('a record with no workspace mode round-trips a rename without writing one', () => {
    const form = buildProjectForm({
      name: 'Demo',
      slug: 'demo',
    } as never);
    expect(form.defaultWorkspaceIsolation).toBe('inherit');
    const payload = buildProjectSavePayload({ ...form, name: 'Renamed' });
    expect(payload.name).toBe('Renamed');
    expect(payload.defaultWorkspaceIsolation).toBeNull();
  });

  test('an explicit choice is sent verbatim', () => {
    for (const mode of ['shared', 'worktree'] as const) {
      const form = buildProjectForm({
        name: 'Demo',
        defaultWorkspaceIsolation: mode,
      } as never);
      expect(form.defaultWorkspaceIsolation).toBe(mode);
      expect(buildProjectSavePayload(form).defaultWorkspaceIsolation).toBe(
        mode,
      );
    }
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
