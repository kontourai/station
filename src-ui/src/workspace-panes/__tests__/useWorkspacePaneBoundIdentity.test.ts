import type { LayoutMetadata } from '@kontourai/station-contracts/layout';
import type { ProjectMetadata } from '@kontourai/station-contracts/project';
import type { WorkspacePaneInstance } from '@kontourai/station-sdk';
import { describe, expect, test } from 'vitest';
import { resolveWorkspacePaneBoundIdentity } from '../useWorkspacePaneBoundIdentity';

const project: ProjectMetadata = {
  id: 'project-id',
  slug: 'project-slug',
  name: 'Project',
  hasWorkingDirectory: false,
  layoutCount: 1,
  hasKnowledge: false,
};
const layout: LayoutMetadata = {
  id: 'layout-id',
  slug: 'coding',
  projectSlug: project.slug,
  type: 'builtin',
  name: 'Coding',
};

function instance(
  boundContext: WorkspacePaneInstance['boundContext'],
): WorkspacePaneInstance {
  return {
    version: '1.0',
    descriptorId: 'pane:test',
    instanceId: 'test',
    stateKey: 'test',
    boundContext,
  } as WorkspacePaneInstance;
}

function resolve(
  boundContext: WorkspacePaneInstance['boundContext'],
  overrides: Partial<
    Parameters<typeof resolveWorkspacePaneBoundIdentity>[0]
  > = {},
) {
  return resolveWorkspacePaneBoundIdentity({
    instance: instance(boundContext),
    needsLayout: true,
    projects: [project],
    layouts: [layout],
    projectsLoading: false,
    projectsError: false,
    layoutsLoading: false,
    layoutsError: false,
    ...overrides,
  });
}

describe('resolveWorkspacePaneBoundIdentity', () => {
  test('keeps a missing Project binding distinct from unavailable data', () => {
    expect(resolve({ layoutId: layout.id })).toEqual({
      state: 'missing-project-binding',
    });
  });

  test('reports a deleted Project as unresolvable', () => {
    expect(
      resolve({ projectId: project.id, layoutId: layout.id }, { projects: [] }),
    ).toEqual({
      state: 'project-unresolvable',
      reason: 'missing',
    });
  });

  test('reports a deleted layout as unresolvable', () => {
    expect(
      resolve({ projectId: project.id, layoutId: layout.id }, { layouts: [] }),
    ).toEqual({
      state: 'layout-unresolvable',
      reason: 'missing',
    });
  });

  test('refuses duplicate stable ids rather than selecting the first match', () => {
    expect(
      resolve(
        { projectId: project.id, layoutId: layout.id },
        { projects: [project, { ...project, name: 'Duplicate' }] },
      ),
    ).toEqual({ state: 'project-unresolvable', reason: 'ambiguous' });
    expect(
      resolve(
        { projectId: project.id, layoutId: layout.id },
        { layouts: [layout, { ...layout, name: 'Duplicate' }] },
      ),
    ).toEqual({ state: 'layout-unresolvable', reason: 'ambiguous' });
  });

  test('surfaces Project query failure', () => {
    expect(
      resolve(
        { projectId: project.id, layoutId: layout.id },
        { projectsError: true },
      ),
    ).toEqual({ state: 'query-error', query: 'projects' });
  });

  test('surfaces layout query failure only after resolving the Project', () => {
    expect(
      resolve(
        { projectId: project.id, layoutId: layout.id },
        { layoutsError: true },
      ),
    ).toEqual({ state: 'query-error', query: 'layouts' });
  });

  test('resolves exact stable Project and layout identities', () => {
    expect(resolve({ projectId: project.id, layoutId: layout.id })).toEqual({
      state: 'resolved',
      project,
      layout,
    });
  });

  test('keeps loading distinct from unavailable and never queries a layout by fallback', () => {
    expect(
      resolve(
        { projectId: project.id, layoutId: layout.id },
        { projects: [], projectsLoading: true },
      ),
    ).toEqual({ state: 'loading' });
    expect(
      resolve(
        { projectId: project.id, layoutId: layout.id },
        { layouts: [], layoutsLoading: true },
      ),
    ).toEqual({ state: 'loading' });
  });
});
