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
    {
      kind: 'git' as const,
      id: 'git.example/acme/other',
      canonicalRemote: 'git.example/acme/other',
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
    /** Runs inside mutateAppConfig, BEFORE the mutation closure — the queued-save seam. */
    duringMutation?: () => void;
    /** Runs inside the async resolver, BEFORE it settles — the deferred-query seam. */
    duringResolve?: () => void;
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
  let manifestNow = manifest;
  let binding: any =
    options.verifiedAt === undefined
      ? undefined
      : {
          verifiedAt: options.verifiedAt,
          projectId: manifest.id,
          resourceId: manifest.repos[0].id,
        };
  let resolveResolution: ((value: unknown) => void) | undefined;
  const resolutionGate = options.duringResolve
    ? new Promise<void>((resolve) => {
        resolveResolution = resolve as (value: unknown) => void;
      })
    : undefined;
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
    manifests: { readProjectManifest: () => manifestNow },
    bindings: { findBinding: () => binding },
    resolver: {
      resolveProjectResource: vi.fn(async () => {
        if (resolutionGate) {
          options.duringResolve?.();
          await resolutionGate;
        }
        return options.bound
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
            };
      }),
    },
    config: {
      loadAppConfig: async () => config,
      mutateAppConfig: async (mutate: any) => {
        options.duringMutation?.();
        config = { ...config, ...mutate(config) };
        return config;
      },
    },
    now: () => new Date('2026-09-20T12:00:00.000Z'),
  });
  return {
    service,
    getConfig: () => config,
    setManifest: (next: typeof manifest | undefined) => {
      manifestNow = (next ?? {
        ...manifest,
        id: 'prj_other',
      }) as typeof manifest;
    },
    setBinding: (next: any) => {
      binding = next;
    },
    resolveResolution: () => resolveResolution?.(undefined),
  };
}

const QUERY = {
  portableProjectId: 'prj_shared',
  resourceId: 'git.example/acme/repo',
};

const OFFER = {
  ...QUERY,
  localProjectId: 'local-id',
  expected: null,
  enabled: true,
};

describe('ProjectContributionService', () => {
  test('a binding without an offer remains disabled and discloses no path', async () => {
    const { service } = fixture({ bound: true, verifiedAt: 1000 });
    const projection = await service.query(QUERY, () => true);
    expect(projection.participation).toBe('disabled');
    expect(projection.execution).toEqual([]);
    expect(JSON.stringify(projection)).not.toContain('/private');
  });

  test('projects only the exact offered bound resource using stored observation freshness', async () => {
    const verifiedAt = Date.parse('2026-09-20T11:00:00.000Z');
    const { service } = fixture({
      offered: true,
      bound: true,
      verifiedAt,
    });
    const projection = await service.query(QUERY, () => true);
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
    expect(await service.query(QUERY, () => true)).toMatchObject({
      sourceObservedAt: null,
      execution: [{ verifiedAt: null }],
    });
  });

  test('offer mutation uses exact config and Project association guards', async () => {
    const { service, getConfig } = fixture();
    await expect(
      service.setExecutionOffer(OFFER, () => true),
    ).resolves.toMatchObject({ enabled: true });
    expect(
      getConfig().contribution['project:prj_shared'].execution.repoIds,
    ).toEqual(['git.example/acme/repo']);
    await expect(
      service.setExecutionOffer({ ...OFFER, enabled: false }, () => true),
    ).rejects.toMatchObject({ code: 'file_storage_conflict' });
  });

  test('a credential revoked before the offer refuses inside the serialized config mutation', async () => {
    const { service, getConfig } = fixture();
    await expect(service.setExecutionOffer(OFFER, () => false)).rejects.toThrow(
      /Offer authority changed/,
    );
    expect(getConfig().contribution).toBeUndefined();
  });

  test('an operator authority revoked while queued refuses inside the config mutation', async () => {
    let revoked = false;
    const f = fixture({
      duringMutation: () => {
        revoked = true;
      },
    });
    await expect(
      f.service.setExecutionOffer(OFFER, () => !revoked),
    ).rejects.toThrow(/Offer authority changed/);
    expect(f.getConfig().contribution).toBeUndefined();
  });

  test('a same-slug manifest replaced while queued refuses the stale offer', async () => {
    let handle: ReturnType<typeof fixture> | undefined;
    const f = fixture({
      duringMutation: () => {
        // Same slug, DIFFERENT portable id: the Project this offer named was
        // replaced between the entry snapshot and the serialized mutation.
        handle!.setManifest({ ...manifest, id: 'prj_replaced' });
      },
    });
    handle = f;
    await expect(
      f.service.setExecutionOffer(OFFER, () => true),
    ).rejects.toThrow(/Project association changed/);
    expect(f.getConfig().contribution).toBeUndefined();
  });

  test('a manifest that drops the offered resource while queued refuses', async () => {
    let handle: ReturnType<typeof fixture> | undefined;
    const f = fixture({
      duringMutation: () => {
        // Same slug, same portable id, but the offered repo is gone from the
        // re-read manifest — the exact resource is no longer declared.
        handle!.setManifest({ ...manifest, repos: [manifest.repos[1]] });
      },
    });
    handle = f;
    await expect(
      f.service.setExecutionOffer(OFFER, () => true),
    ).rejects.toThrow(/Project association changed/);
    expect(f.getConfig().contribution).toBeUndefined();
  });

  test('removing the last offered execution keeps unrelated consent active', async () => {
    const f = fixture({ offered: true });
    const seeded = {
      enabled: true,
      execution: { repoIds: ['git.example/acme/repo'] },
      agents: { slugs: ['planner'] },
      inference: { connectionIds: ['conn-1'] },
    };
    f.getConfig().contribution['project:prj_shared'] = seeded;
    await expect(
      f.service.setExecutionOffer(
        { ...OFFER, expected: seeded, enabled: false },
        () => true,
      ),
    ).resolves.toMatchObject({
      enabled: true,
      agents: { slugs: ['planner'] },
      inference: { connectionIds: ['conn-1'] },
      execution: { repoIds: [] },
    });
  });

  test('enabling a disabled master with dormant unrelated declarations refuses', async () => {
    const f = fixture();
    const dormant = {
      execution: { repoIds: ['git.example/acme/other'] },
    };
    f.getConfig().contribution = { 'project:prj_shared': dormant };
    await expect(
      f.service.setExecutionOffer(
        { ...OFFER, resourceId: 'git.example/acme/repo', expected: dormant },
        () => true,
      ),
    ).rejects.toThrow(/activate unrelated contribution/);
    expect(
      f.getConfig().contribution['project:prj_shared'].enabled,
    ).toBeUndefined();
  });

  test('enabling on a disabled master with no other declarations activates only this resource', async () => {
    const { service } = fixture();
    await expect(service.setExecutionOffer(OFFER, () => true)).resolves.toEqual(
      {
        enabled: true,
        execution: { repoIds: ['git.example/acme/repo'] },
      },
    );
  });

  test('a query authority revoked at response release refuses instead of answering', async () => {
    const { service } = fixture({
      offered: true,
      bound: true,
      verifiedAt: 1000,
    });
    await expect(service.query(QUERY, () => false)).rejects.toThrow(
      /Query authority changed/,
    );
  });

  test('an offer withdrawn while resolution is pending never returns the old bound status', async () => {
    const { service, resolveResolution, getConfig } = fixture({
      offered: true,
      bound: true,
      verifiedAt: Date.parse('2026-09-20T11:00:00.000Z'),
      duringResolve: () => {
        // The operator withdraws the offer while the resolver is in flight.
        delete getConfig().contribution['project:prj_shared'];
      },
    });
    const pending = service.query(QUERY, () => true);
    resolveResolution();
    await expect(pending).resolves.toMatchObject({
      participation: 'contributed-unavailable',
      sourceObservedAt: null,
      execution: [{ bound: false, verifiedAt: null }],
    });
  });

  test('a binding rebound while resolution is pending is not reported with a stale observation', async () => {
    const verifiedAt = Date.parse('2026-09-20T11:00:00.000Z');
    const { service, resolveResolution, setBinding } = fixture({
      offered: true,
      bound: true,
      verifiedAt,
      duringResolve: () => {
        // The old binding is replaced (withdraw + rebind): a NEW observation
        // exists, but it was not the one captured before the async read.
        setBinding({
          verifiedAt: verifiedAt + 5_000,
          projectId: 'prj_shared',
          resourceId: 'git.example/acme/repo',
        });
      },
    });
    const pending = service.query(QUERY, () => true);
    resolveResolution();
    await expect(pending).resolves.toMatchObject({
      participation: 'contributed-unavailable',
      sourceObservedAt: null,
      execution: [{ bound: false, verifiedAt: null }],
    });
  });
});
