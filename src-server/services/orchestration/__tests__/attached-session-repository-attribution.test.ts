/**
 * #3386 Phase A: an attached session is attributed to a project by its git
 * repository (any worktree of it), and a session no project claims is
 * followed under No project instead of dropped. Every repository here is a
 * real `git init` / `git worktree add` on disk; nothing about git is mocked.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { AttachedSessionSource } from '../../../providers/sessions/attached-session-source.js';
import { HOSTED_TENANT_REGISTRY_FILE_ENV } from '../../../runtime/bootstrap/runtime-tenant-context.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../identity/principal-resolver.js';
import {
  type AttachedProjectRoot,
  AttachedSessionFollowService,
  resolveAttachedSessionProject,
} from '../attached-session-follow-service.js';
import {
  createPollRepositoryLookup,
  locateRepository,
} from '../attached-session-repository.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import type { SessionAnswerabilityObservation } from '../open-requests.js';
import { buildOrchestrationSessionSummary } from '../orchestration-session-state.js';
import { SessionAuthorization } from '../session-authorization.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  orchestrationEventsPersisted: { add: vi.fn() },
  orchestrationEventPersistDuration: { record: vi.fn() },
  attachedSessionDiscovery: { add: vi.fn() },
  attachedSessionScanDuration: { record: vi.fn() },
  attachedSessionEventsImported: { add: vi.fn() },
  attachedSessionProjectAttribution: { add: vi.fn() },
  sessionOwnerCacheOps: { add: vi.fn() },
}));

const OBSERVATION: SessionAnswerabilityObservation = {
  threadAttachment: 'detached',
  providerRegistered: true,
  observedBy: 'test-instance#0',
  observedAt: '2026-08-03T00:00:00.000Z',
};

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
}

/** A repository with one commit, so `git worktree add` has something to check out. */
function repository(path: string): string {
  mkdirSync(join(path, 'packages', 'app', 'src'), { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'commit', '-q', '--allow-empty', '-m', 'init');
  return path;
}

function worktree(main: string, path: string, branch: string): string {
  git(main, 'worktree', 'add', '-q', '-b', branch, path);
  mkdirSync(join(path, 'packages', 'app', 'src'), { recursive: true });
  return path;
}

const tempDir = trackTempDirs();
let dir: string;

beforeEach(() => {
  dir = realpathSync.native(tempDir('station-attached-repo-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function attribute(cwd: string, projects: AttachedProjectRoot[]) {
  return resolveAttachedSessionProject(
    cwd,
    projects,
    createPollRepositoryLookup(),
  );
}

describe('attribution by repository (#3386)', () => {
  test('a worktree outside the project folder belongs to the project on its repository', async () => {
    const main = repository(join(dir, 'station'));
    // The two real-world shapes: a sibling worktree folder, and another
    // tool's worktree root (T3 Code's `~/.t3/worktrees/<repo>/<name>`).
    const sibling = worktree(
      main,
      join(dir, 'station-worktrees', 'lane'),
      'lane',
    );
    const t3 = worktree(
      main,
      join(dir, '.t3', 'worktrees', 'station', 'x'),
      'x',
    );
    const projects = [{ slug: 'station', workingDirectory: main }];

    for (const cwd of [sibling, join(t3, 'packages', 'app')]) {
      expect(await attribute(cwd, projects)).toEqual({
        state: 'attributed',
        slug: 'station',
        cwd: realpathSync.native(cwd),
        workingDirectory: main,
      });
    }
  });

  test('a project on a subfolder claims that subfolder in every worktree, and only it', async () => {
    const main = repository(join(dir, 'mono'));
    const lane = worktree(main, join(dir, 'mono-lane'), 'lane');
    const projects = [
      { slug: 'app', workingDirectory: join(main, 'packages', 'app') },
    ];

    expect(
      await attribute(join(lane, 'packages', 'app', 'src'), projects),
    ).toMatchObject({ state: 'attributed', slug: 'app' });
    expect(await attribute(lane, projects)).toEqual({
      state: 'unattributed',
    });
  });

  test('the longest place in the repository wins, as with folders', async () => {
    const main = repository(join(dir, 'mono'));
    const lane = worktree(main, join(dir, 'mono-lane'), 'lane');
    const projects = [
      { slug: 'mono', workingDirectory: main },
      { slug: 'app', workingDirectory: join(main, 'packages', 'app') },
    ];

    expect(
      await attribute(join(lane, 'packages', 'app'), projects),
    ).toMatchObject({ state: 'attributed', slug: 'app' });
    expect(await attribute(lane, projects)).toMatchObject({
      state: 'attributed',
      slug: 'mono',
    });
  });

  test('two projects on two checkouts of one repository are ambiguous for a third', async () => {
    const main = repository(join(dir, 'station'));
    const second = worktree(main, join(dir, 'second'), 'second');
    const third = worktree(main, join(dir, 'third'), 'third');

    expect(
      await attribute(third, [
        { slug: 'beta', workingDirectory: second },
        { slug: 'alpha', workingDirectory: main },
      ]),
    ).toMatchObject({ state: 'ambiguous', candidates: ['alpha', 'beta'] });
    // ...while each checkout's own folder still decides for itself.
    expect(
      await attribute(second, [
        { slug: 'beta', workingDirectory: second },
        { slug: 'alpha', workingDirectory: main },
      ]),
    ).toMatchObject({ state: 'attributed', slug: 'beta' });
  });

  test('a folder in no repository, or another repository, is unattributed', async () => {
    const main = repository(join(dir, 'station'));
    const other = repository(join(dir, 'other'));
    const plain = join(dir, 'scratch');
    mkdirSync(plain);
    const projects = [{ slug: 'station', workingDirectory: main }];

    expect(await attribute(plain, projects)).toEqual({ state: 'unattributed' });
    expect(await attribute(other, projects)).toEqual({ state: 'unattributed' });
  });

  test('a nested repository belongs to itself, not to the repository around it', async () => {
    const main = repository(join(dir, 'station'));
    const lane = worktree(main, join(dir, 'lane'), 'lane');
    // A separate repository checked out inside a worktree of the project's.
    const nested = repository(join(lane, 'vendor', 'lib'));
    const projects = [{ slug: 'station', workingDirectory: main }];

    expect(await attribute(nested, projects)).toEqual({
      state: 'unattributed',
    });
    // A folder match is still first: a nested repository INSIDE the project
    // folder stays the project's, as it always was.
    const inside = repository(join(main, 'vendor', 'inner'));
    expect(await attribute(inside, projects)).toMatchObject({
      state: 'attributed',
      slug: 'station',
    });
  });

  // #3386 review F3: a `.git` FILE can name any repository.
  describe('a crafted .git never claims another repository', () => {
    test("a project whose .git file names another checkout's worktree entry does not claim that worktree", async () => {
      const other = repository(join(dir, 'other'));
      const otherWorktree = worktree(other, join(dir, 'other-wt'), 'wt');
      const evil = join(dir, 'evil');
      mkdirSync(evil);
      writeFileSync(
        join(evil, '.git'),
        `gitdir: ${join(other, '.git', 'worktrees', 'other-wt')}\n`,
      );

      expect(
        await attribute(otherWorktree, [
          { slug: 'evil', workingDirectory: evil },
        ]),
      ).toEqual({ state: 'unattributed' });
      // With the genuine owner configured too, it is not even a tie.
      expect(
        await attribute(otherWorktree, [
          { slug: 'evil', workingDirectory: evil },
          { slug: 'other', workingDirectory: other },
        ]),
      ).toMatchObject({ state: 'attributed', slug: 'other' });
    });

    test('a .git file naming the common directory itself is refused', async () => {
      const other = repository(join(dir, 'other'));
      const evil = join(dir, 'evil');
      mkdirSync(evil);
      writeFileSync(join(evil, '.git'), `gitdir: ${join(other, '.git')}\n`);

      expect(
        await attribute(other, [{ slug: 'evil', workingDirectory: evil }]),
      ).toEqual({ state: 'unattributed' });
    });

    test("a session folder cannot claim a project's repository with a crafted .git", async () => {
      const main = repository(join(dir, 'station'));
      const lane = worktree(main, join(dir, 'lane'), 'lane');
      const crafted = join(dir, 'crafted');
      mkdirSync(crafted);
      // The lane's real entry, whose back-pointer names the lane, not this folder.
      writeFileSync(
        join(crafted, '.git'),
        `gitdir: ${join(main, '.git', 'worktrees', 'lane')}\n`,
      );
      const linked = join(dir, 'linked');
      mkdirSync(linked);
      symlinkSync(join(main, '.git'), join(linked, '.git'));
      const projects = [{ slug: 'station', workingDirectory: main }];

      expect(await attribute(crafted, projects)).toEqual({
        state: 'unattributed',
      });
      expect(await attribute(linked, projects)).toEqual({
        state: 'unattributed',
      });
      // The genuine worktree still matches.
      expect(await attribute(lane, projects)).toMatchObject({
        state: 'attributed',
        slug: 'station',
      });
    });

    test('a session inside a submodule of an outside worktree is No project (documented limit)', async () => {
      const library = repository(join(dir, 'library'));
      const main = repository(join(dir, 'station'));
      const fileProtocol = ['-c', 'protocol.file.allow=always'];
      git(
        main,
        ...fileProtocol,
        'submodule',
        'add',
        '-q',
        library,
        'vendor/library',
      );
      git(main, 'commit', '-q', '-m', 'submodule');
      const lane = worktree(main, join(dir, 'lane'), 'lane');
      git(lane, ...fileProtocol, 'submodule', 'update', '-q', '--init');
      const projects = [{ slug: 'station', workingDirectory: main }];

      // git picks the submodule's own `.git`; that file names a
      // `modules/...` git directory with no worktree back-pointer, so it is
      // refused, and the climb does not skip past it to the worktree.
      expect(
        await attribute(join(lane, 'vendor', 'library'), projects),
      ).toEqual({ state: 'unattributed' });
      // Inside the project folder, the folder match still claims it.
      expect(
        await attribute(join(main, 'vendor', 'library'), projects),
      ).toMatchObject({ state: 'attributed', slug: 'station' });
    });
  });

  test('a removed worktree is unattributed, without throwing', async () => {
    const main = repository(join(dir, 'station'));
    const lane = worktree(main, join(dir, 'lane'), 'lane');
    git(main, 'worktree', 'remove', '--force', lane);

    await expect(
      attribute(join(lane, 'packages', 'app'), [
        { slug: 'station', workingDirectory: main },
      ]),
    ).resolves.toEqual({ state: 'unattributed' });
    // The lookup itself answers "in no repository", not merely a per-poll
    // cache that swallowed its rejection.
    await expect(
      locateRepository(join(lane, 'packages', 'app')),
    ).resolves.toBeUndefined();
  });
});

describe('a session no project claims is followed under No project (#3386)', () => {
  let store: EventStore;
  let session: {
    provider: string;
    sessionId: string;
    threadId: string;
    cwd: string;
    createdAt: string;
    sourceHandle: string;
  };

  beforeEach(() => {
    store = new EventStore(join(dir, 'orchestration.sqlite'));
    const cwd = join(dir, 'scratch');
    mkdirSync(cwd);
    session = {
      provider: 'claude',
      sessionId: 'session-1',
      threadId: 'external:claude:hashed-session-1',
      cwd,
      createdAt: '2026-07-22T00:00:00.000Z',
      sourceHandle: 'opaque-source-handle',
    };
  });

  afterEach(() => store.close());

  function source(): AttachedSessionSource {
    return {
      provider: 'claude',
      kind: 'claude-transcript',
      discover: vi
        .fn()
        .mockResolvedValue({ outcome: 'ok', sessions: [session] }),
      read: vi.fn().mockResolvedValue({
        outcome: 'ok',
        events: [
          {
            eventId: 'event-1',
            provider: 'claude',
            threadId: session.threadId,
            createdAt: '2026-07-22T00:00:01.000Z',
            method: 'content.text-delta',
            itemId: 'item-1',
            delta: 'hello',
          },
        ],
        cursor: 1,
      }),
    };
  }

  function follow(
    projects: () => AttachedProjectRoot[],
    from = source(),
  ): AttachedSessionFollowService {
    return new AttachedSessionFollowService({
      sources: [from],
      eventStore: store,
      eventBus: new EventBus(),
      listProjects: projects,
    });
  }

  /** What Activity, Home and the detail panel read. */
  function summarize() {
    const persisted = store
      .readSessions()
      .find((item) => item.threadId === session.threadId);
    if (!persisted) throw new Error('session was never persisted');
    return buildOrchestrationSessionSummary({
      answerability: OBSERVATION,
      persisted,
      events: store
        .listEvents(session.threadId)
        .map((item) => item.payload as unknown as CanonicalRuntimeEvent),
    });
  }

  test('it is imported, carries no project, and is readable only by the local operator', async () => {
    const from = source();
    await follow(() => [], from).pollNow();

    expect(from.read).toHaveBeenCalled();
    const summary = summarize();
    expect(summary.controlMode).toBe('read-only-attached');
    expect(summary.projectSlug).toBeUndefined();
    expect(summary.projectAttribution).toBeUndefined();
    expect(store.listEvents(session.threadId).map((item) => item.id)).toContain(
      'event-1',
    );

    const authz = new SessionAuthorization({ eventStore: store });
    const as = (userId: string) =>
      sessionReadAuthorityFromRequest(userId, undefined, undefined);
    expect(
      authz.canReadSession(session.threadId, as(LOCAL_OPERATOR_PRINCIPAL_ID)),
    ).toBe(true);
    expect(authz.canReadSession(session.threadId, as('stranger'))).toBe(false);
  });

  test('a hosted Station still skips it', async () => {
    vi.stubEnv(HOSTED_TENANT_REGISTRY_FILE_ENV, join(dir, 'tenants.json'));
    const from = source();
    await follow(() => [], from).pollNow();

    expect(from.read).not.toHaveBeenCalled();
    expect(store.readSessions()).toEqual([]);
    expect(store.listEvents(session.threadId)).toEqual([]);
  });

  test('a session in a worktree outside the project folder now reaches the read model with its project', async () => {
    const main = repository(join(dir, 'station'));
    session = {
      ...session,
      cwd: worktree(main, join(dir, 'station-worktrees', 'lane'), 'lane'),
    };
    await follow(() => [{ slug: 'station', workingDirectory: main }]).pollNow();

    expect(summarize().projectSlug).toBe('station');
  });

  test('its No project is stable across polls and restarts', async () => {
    await follow(() => []).pollNow();
    const first = store.listEvents(session.threadId).length;
    // Not just deduplicated by event id: a restart reads the stored No
    // project back and offers the store no envelope at all.
    const append = vi.spyOn(store, 'appendEventIfAbsent');
    for (let index = 0; index < 5; index += 1) {
      await follow(() => []).pollNow();
    }
    expect(
      append.mock.calls.filter(([stored]) =>
        stored.method.startsWith('session.'),
      ),
    ).toEqual([]);
    expect(store.listEvents(session.threadId)).toHaveLength(first);
  });

  test('the read model treats a newer No project as newer than an older project', async () => {
    await follow(() => [
      { slug: 'scratch', workingDirectory: session.cwd },
    ]).pollNow();
    expect(summarize().projectSlug).toBe('scratch');
    // The writer only says No project after a project when the project is
    // beyond its bounded look-back; the reader must still take the newest.
    const configured = store
      .listEvents(session.threadId)
      .map((item) => item.payload as unknown as CanonicalRuntimeEvent)
      .find((item) => item.method === 'session.configured');
    if (!configured) throw new Error('no envelope');
    store.appendEventIfAbsent({
      ...configured,
      eventId: 'later-no-project',
      createdAt: '2026-07-22T00:00:02.000Z',
      metadata: {
        controlMode: 'read-only-attached',
        projectAttribution: 'unattributed',
        attachedProvider: 'claude',
        userId: LOCAL_OPERATOR_PRINCIPAL_ID,
      },
    });
    expect(summarize().projectSlug).toBeUndefined();
  });

  test('a project added later claims it', async () => {
    let projects: AttachedProjectRoot[] = [];
    await follow(() => projects).pollNow();
    expect(summarize().projectSlug).toBeUndefined();

    projects = [{ slug: 'scratch', workingDirectory: session.cwd }];
    await follow(() => projects).pollNow();
    expect(summarize().projectSlug).toBe('scratch');
  });

  test('losing its match never erases a project the log already names', async () => {
    let projects: AttachedProjectRoot[] = [
      { slug: 'scratch', workingDirectory: session.cwd },
    ];
    await follow(() => projects).pollNow();
    const attributed = store.listEvents(session.threadId).length;

    // e.g. its worktree was removed, so nothing leads to the repository now.
    projects = [];
    await follow(() => projects).pollNow();
    await follow(() => projects).pollNow();

    expect(summarize().projectSlug).toBe('scratch');
    expect(store.listEvents(session.threadId)).toHaveLength(attributed);
  });
});
