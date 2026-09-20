import { contributionFreshness } from '@kontourai/station-contracts/contribution';
import { describe, expect, test, vi } from 'vitest';
import { ProjectContributionService } from '../project-contribution-service.js';

const manifest = {
  schemaVersion: 1 as const,
  id: 'prj_shared',
  slug: 'local',
  name: 'Local',
  repos: [
    {
      kind: 'git' as const,
      id: 'git.example/acme/repo',
      canonicalRemote: 'git.example/acme/repo',
    },
  ],
  knowledge: [],
  agents: [],
  integrations: [],
  layouts: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function fixture(
  options: {
    offered?: boolean;
    bound?: boolean;
    verifiedAt?: number | null;
  } = {},
) {
  let config: any = options.offered
    ? {
        contribution: {
          'project:prj_shared': {
            enabled: true,
            execution: { repoIds: ['git.example/acme/repo'] },
          },
        },
      }
    : {};
  const project = {
    id: 'local-id',
    slug: 'local',
    name: 'Local',
    createdAt: '',
    updatedAt: '',
    hasWorkingDirectory: false,
    layoutCount: 0,
    hasKnowledge: false,
  };
  const service = new ProjectContributionService({
    source: {
      listProjects: () => [project],
      projectRevision: () => ({
        value: project,
        replace: vi.fn(),
        remove: vi.fn(),
        createLayout: vi.fn(),
        withCurrentRead: async (op: any) => op(project),
      }),
    },
    manifests: { readProjectManifest: () => manifest },
    bindings: {
      findBinding: () =>
        options.verifiedAt === undefined
          ? undefined
          : ({
              verifiedAt: options.verifiedAt,
              projectId: manifest.id,
              resourceId: manifest.repos[0].id,
            } as any),
    },
    resolver: {
      resolveProjectResource: vi.fn(async () =>
        options.bound
          ? {
              state: 'bound' as const,
              resourceId: manifest.repos[0].id,
              path: '/private/not-projected',
            }
          : {
              state: 'missing' as const,
              resourceId: manifest.repos[0].id,
              record: 'binding' as const,
              declaredPath: '/private/not-projected',
              reason: '/private/not-projected',
            },
      ),
    },
    config: {
      loadAppConfig: async () => config,
      mutateAppConfig: async (mutate: any) => {
        config = { ...config, ...mutate(config) };
        return config;
      },
    },
    now: () => new Date('2026-09-20T12:00:00.000Z'),
  });
  return { service, getConfig: () => config };
}

describe('ProjectContributionService', () => {
  test('a binding without an offer remains disabled and discloses no path', async () => {
    const { service } = fixture({ bound: true, verifiedAt: 1000 });
    const projection = await service.query({
      portableProjectId: 'prj_shared',
      resourceId: 'git.example/acme/repo',
    });
    expect(projection.participation).toBe('disabled');
    expect(projection.execution).toEqual([]);
    expect(JSON.stringify(projection)).not.toContain('/private');
  });

  test('projects only the exact offered bound resource using stored observation freshness', async () => {
    const verifiedAt = Date.parse('2026-09-20T11:00:00.000Z');
    const { service } = fixture({ offered: true, bound: true, verifiedAt });
    const projection = await service.query({
      portableProjectId: 'prj_shared',
      resourceId: 'git.example/acme/repo',
    });
    expect(projection).toMatchObject({
      participation: 'contributing',
      sourceObservedAt: '2026-09-20T11:00:00.000Z',
      execution: [{ repoId: 'git.example/acme/repo', bound: true, verifiedAt }],
    });
    expect(projection.projectedAt).toBe('2026-09-20T12:00:00.000Z');
    expect(
      contributionFreshness(projection, {
        now: Date.parse(projection.projectedAt),
        maxAgeMs: 30 * 60 * 1000,
      }),
    ).toBe('stale');
  });

  test('compat resolution never fabricates a binding observation', async () => {
    const { service } = fixture({ offered: true, bound: true });
    expect(
      await service.query({
        portableProjectId: 'prj_shared',
        resourceId: 'git.example/acme/repo',
      }),
    ).toMatchObject({
      sourceObservedAt: null,
      execution: [{ verifiedAt: null }],
    });
  });

  test('offer mutation uses exact config and Project association guards', async () => {
    const { service, getConfig } = fixture();
    await expect(
      service.setExecutionOffer({
        portableProjectId: 'prj_shared',
        localProjectId: 'local-id',
        resourceId: 'git.example/acme/repo',
        expected: null,
        enabled: true,
      }),
    ).resolves.toMatchObject({ enabled: true });
    expect(
      getConfig().contribution['project:prj_shared'].execution.repoIds,
    ).toEqual(['git.example/acme/repo']);
    await expect(
      service.setExecutionOffer({
        portableProjectId: 'prj_shared',
        localProjectId: 'local-id',
        resourceId: 'git.example/acme/repo',
        expected: null,
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: 'file_storage_conflict' });
  });
});
