/**
 * #2377 slice C2a: a plain folder's scope, on the real filesystem. The route
 * tests (`runtime-routes-station-control-dispatch-scope.test.ts`) drive the
 * same function through the dispatch routes; this pins the path edges.
 */
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  type StationControlPolicyCaller,
  stationControlRefusalBody,
  stationControlScopeRefusal,
} from '../../../tools/station-control-policy.js';
import {
  createStationControlDispatchScope,
  stationControlDirectoryScope,
} from '../station-control-dispatch-scope.js';

const makeTempDir = trackTempDirs();

function tree() {
  const root = realpathSync(makeTempDir('folder-scope-'));
  const project = join(root, 'proj');
  const nested = join(project, 'inner');
  for (const dir of [
    join(project, 'sub'),
    join(nested, 'deep'),
    join(root, 'proj-2'),
    join(root, 'elsewhere'),
  ])
    mkdirSync(dir, { recursive: true });
  symlinkSync(project, join(root, 'alias'));
  return { root, project, nested };
}

describe('stationControlDirectoryScope', () => {
  test('whole path segments, canonical paths, the deepest Project', () => {
    const { root, project, nested } = tree();
    const projects = [
      { id: 'p', workingDirectory: `${project}/` },
      { id: 'n', workingDirectory: nested },
    ];
    const scope = (cwd: string) => stationControlDirectoryScope(cwd, projects);
    expect(scope(project)).toEqual({ kind: 'project', id: 'p' });
    expect(scope(`${project}/sub/`)).toEqual({ kind: 'project', id: 'p' });
    expect(scope(join(project, 'sub', '..', 'sub'))).toEqual({
      kind: 'project',
      id: 'p',
    });
    expect(scope(join(root, 'proj-2'))).toEqual({ kind: 'global' });
    expect(scope(root)).toEqual({ kind: 'global' });
    expect(scope(join(nested, 'deep'))).toEqual({ kind: 'project', id: 'n' });
    // A symlink resolves to where it points, either side.
    expect(scope(join(root, 'alias', 'sub'))).toEqual({
      kind: 'project',
      id: 'p',
    });
    expect(
      stationControlDirectoryScope(join(project, 'sub'), [
        { id: 'via-alias', workingDirectory: join(root, 'alias') },
      ]),
    ).toEqual({ kind: 'project', id: 'via-alias' });
    // A folder that cannot be resolved is unreadable.
    expect(scope(join(root, 'missing'))).toEqual({ kind: 'unreadable' });
  });

  test('a Project whose directory is gone contains nothing; a folder under it cannot resolve', () => {
    const { root } = tree();
    const projects = [{ id: 'gone', workingDirectory: join(root, 'gone') }];
    expect(
      stationControlDirectoryScope(join(root, 'elsewhere'), projects),
    ).toEqual({ kind: 'global' });
    // A folder under a vanished Project cannot itself resolve.
    expect(
      stationControlDirectoryScope(join(root, 'gone', 'x'), projects),
    ).toEqual({ kind: 'unreadable' });
  });
});

// Project working directories are stored tilde-literal (`~/proj`,
// station#3155); the folder scope and a Project workspace's `cwd` check read
// them expanded.
describe('a Project stored as ~/…', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function homeWithProject() {
    const home = realpathSync(makeTempDir('folder-scope-home-'));
    mkdirSync(join(home, 'proj', 'sub'), { recursive: true });
    mkdirSync(join(home, 'elsewhere'), { recursive: true });
    vi.stubEnv('HOME', home);
    return home;
  }

  test('a folder inside it is that Project’s', () => {
    const home = homeWithProject();
    const projects = [{ id: 'tilde', workingDirectory: '~/proj' }];
    expect(
      stationControlDirectoryScope(join(home, 'proj', 'sub'), projects),
    ).toEqual({ kind: 'project', id: 'tilde' });
    expect(
      stationControlDirectoryScope(join(home, 'elsewhere'), projects),
    ).toEqual({ kind: 'global' });
  });

  test('a Project workspace cwd inside it is admitted, one outside is not', () => {
    const home = homeWithProject();
    const scope = createStationControlDispatchScope({
      resolveRecord: () => undefined,
      sessionOwnerId: () => undefined,
      sessionExists: () => false,
      sessionRunsHost: () => false,
      conversationThreads: () => [],
      conversationSessionIds: () => [],
      defaultSessionDirectory: () => undefined,
      projectDirectories: () => [{ id: 'tilde', workingDirectory: '~/proj' }],
      sessionCwd: () => undefined,
      projectIdForSlug: (slug) => (slug === 'tilde-slug' ? 'tilde' : undefined),
      ownerMay: () => true,
    });
    const newIn = (directory: string) =>
      scope.target({
        kind: 'new',
        ownerId: 'human:local:operator',
        projectSlug: 'tilde-slug',
        directory,
        remote: false,
      });
    expect(newIn(join(home, 'proj', 'sub'))).toMatchObject({
      scope: { kind: 'project', id: 'tilde' },
      canonicalCwd: join(home, 'proj', 'sub'),
    });
    expect(newIn(join(home, 'elsewhere'))).toMatchObject({
      scope: { kind: 'unreadable' },
    });
  });
});

// Owner decision 2026-10-13 and its review: the caller's own Project for a
// new Session that names no workspace, and the refusal of a Project the
// owner cannot use, read from the real scope composition over Station-shaped
// records. No dispatch route lets an account member's request reach the rule
// today: the Agent audience gate answers a member turn first (#3276), until
// #3277. When it does, a missing Project already reaches the rule on every
// new-session route rather than failing earlier on its default Environment
// (`newSessionFacts`; the route test 'a named Project that does not exist
// reaches the scope rule…'), so the two answer alike there too.
describe('the caller’s own Project, and a Project the owner cannot use', () => {
  const MEMBER = 'human:deployment:issuer:member';
  function scopeWith(options: {
    projects: { id: string; slug?: string; workingDirectory?: string }[];
    slugIds?: Record<string, string>;
    executeIn?: string[];
  }) {
    return createStationControlDispatchScope({
      resolveRecord: () => undefined,
      sessionOwnerId: () => undefined,
      sessionExists: () => false,
      sessionRunsHost: () => false,
      conversationThreads: () => [],
      conversationSessionIds: () => [],
      defaultSessionDirectory: () => undefined,
      sessionCwd: () => undefined,
      projectDirectories: () => options.projects,
      projectIdForSlug: (slug) => {
        const id =
          options.slugIds?.[slug] ??
          options.projects.find((project) => project.slug === slug)?.id;
        if (!id) throw new Error('no project');
        return id;
      },
      ownerMay: (ownerId, projectId, action) =>
        ownerId === MEMBER &&
        action !== 'approve' &&
        (options.executeIn ?? []).includes(projectId),
    });
  }
  const caller = (
    extra: Partial<StationControlPolicyCaller> = {},
  ): StationControlPolicyCaller => ({
    assurance: 'bearer-exposed',
    principal: { id: MEMBER, elevationEligible: true },
    localProjectId: 'mine',
    projectIdSource: 'session-record',
    ...extra,
  });

  test('a Project that does not exist and one the owner is no member of answer identically', () => {
    const root = realpathSync(makeTempDir('own-project-'));
    const scope = scopeWith({
      projects: [
        { id: 'mine', slug: 'mine', workingDirectory: root },
        { id: 'secret', slug: 'secret', workingDirectory: root },
      ],
      executeIn: ['mine'],
    });
    const answer = (
      projectSlug: string,
      assurance: 'bound' | 'bearer-exposed',
    ) =>
      stationControlRefusalBody(
        stationControlScopeRefusal(
          caller({ assurance }),
          scope.target({
            kind: 'new',
            ownerId: MEMBER,
            projectSlug,
            remote: false,
          }),
        )!,
      );
    for (const assurance of ['bearer-exposed', 'bound'] as const) {
      expect(answer('secret', assurance)).toEqual(answer('ghost', assurance));
      expect(answer('ghost', assurance)).toMatchObject({
        code: 'station_control_out_of_scope',
        reason: 'target-unavailable',
      });
    }
  });

  test('the default is the record’s Project only with a folder, a slug that leads back, and execute held', () => {
    const root = realpathSync(makeTempDir('own-project-'));
    const own = (
      options: Parameters<typeof scopeWith>[0],
      extra: Partial<StationControlPolicyCaller> = {},
    ) => scopeWith(options).ownProjectSlug(caller(extra));
    const mine = { id: 'mine', slug: 'mine-slug', workingDirectory: root };
    expect(own({ projects: [mine], executeIn: ['mine'] })).toBe('mine-slug');
    // No working directory: nothing to run in.
    expect(
      own({
        projects: [{ id: 'mine', slug: 'mine-slug' }],
        executeIn: ['mine'],
      }),
    ).toBeUndefined();
    // The slug now names another Project.
    expect(
      own({
        projects: [mine],
        slugIds: { 'mine-slug': 'someone-else' },
        executeIn: ['mine'],
      }),
    ).toBeUndefined();
    // The owner may view but not dispatch there.
    expect(own({ projects: [mine], executeIn: [] })).toBeUndefined();
    // No recorded owner, a slug looked up now, or the global space.
    expect(
      own({ projects: [mine], executeIn: ['mine'] }, { principal: undefined }),
    ).toBeUndefined();
    expect(
      own(
        { projects: [mine], executeIn: ['mine'] },
        { projectIdSource: 'slug-lookup' },
      ),
    ).toBeUndefined();
    expect(
      own(
        { projects: [mine], executeIn: ['mine'] },
        { localProjectId: undefined, projectIdSource: undefined },
      ),
    ).toBeUndefined();
  });
});
