/**
 * #3386: Continue in Station for a conversation attached from a git worktree
 * outside the project folder, and for one no project claims. Every
 * repository here is a real `git init` / `git worktree add` on disk, and
 * every adoption goes through the real OrchestrationService and SQLite store;
 * only the engine is a test adapter, which records what Station asked it to
 * start and publishes `session.started` the way real adapters do.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AdoptSessionTarget,
  OrchestrationCommand,
  OrchestrationSessionSummary,
} from '@kontourai/station-contracts/orchestration';
import type {
  ProviderSession,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { ProviderSessionAdoptInput } from '../../../providers/adapter-shape.js';
import { FileTreeService } from '../../projects/file-tree-service.js';
import { sessionWorkspaceDirectoryFor } from '../../projects/session-workspace-directory.js';
import {
  noProjectFolderRefusal,
  resolveContinuationPlace,
} from '../attached-session-continuation-place.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

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

function repository(path: string): string {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'commit', '-q', '--allow-empty', '-m', 'init');
  return path;
}

/** An engine that records each adoption and publishes its child's start. */
class AdoptingAdapter extends GateTestAdapter {
  readonly adoptions: ProviderSessionAdoptInput[] = [];
  /** Runs once, while Station checks the engine is ready: just before it would start it. */
  onReadiness: (() => void) | undefined;

  async getPrerequisites() {
    const hook = this.onReadiness;
    this.onReadiness = undefined;
    hook?.();
    return [];
  }

  async adoptSession(
    input: ProviderSessionAdoptInput,
  ): Promise<ProviderSession> {
    this.adoptions.push(input);
    const now = new Date().toISOString();
    this.events.push({
      provider: 'claude',
      threadId: input.threadId,
      sessionId: input.threadId,
      eventId: `evt-${input.threadId}-started`,
      method: 'session.started',
      createdAt: now,
      initialState: 'created',
      metadata: input.metadata,
    } as never);
    return {
      provider: 'claude',
      threadId: input.threadId,
      status: 'ready',
      cwd: input.cwd,
      resumeCursor: `child-of-${input.sourceSessionId}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  async discardSession(): Promise<void> {}

  /** Every turn Station sent to an engine session. */
  readonly turns: Array<{ threadId: string; input: string }> = [];

  async sendTurn(input: { threadId: string; input: string }) {
    this.turns.push({ threadId: input.threadId, input: input.input });
    return { threadId: input.threadId, turnId: `turn-${this.turns.length}` };
  }

  /** Every engine start Station asked for after adoption (a restart's respawn). */
  readonly starts: ProviderSessionStartInput[] = [];

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    this.starts.push(input);
    return super.startSession(input);
  }
}

const tempDir = trackTempDirs();
let dir: string;
let main: string;
let lane: string;
let store: EventStore;
let adapter: AdoptingAdapter;
let service: OrchestrationService;
/** Earlier processes of a restart test, shut down after it. */
const retired: OrchestrationService[] = [];
let projects: Array<{ slug: string; workingDirectory: string; id?: string }>;

beforeEach(() => {
  dir = realpathSync.native(tempDir('station-attached-continue-'));
  // The home folder and Station's data folder are this test's own, so the
  // too-broad rules are exercised without touching the real ones.
  mkdirSync(join(dir, 'home'));
  vi.stubEnv('HOME', join(dir, 'home'));
  vi.stubEnv('STATION_HOME', join(dir, 'home', 'station-data'));
  main = repository(join(dir, 'station'));
  lane = join(dir, 'station-worktrees', 'lane');
  git(main, 'worktree', 'add', '-q', '-b', 'lane', lane);
  projects = [{ slug: 'station', workingDirectory: main, id: 'project-1' }];
  store = new EventStore(join(dir, 'events.sqlite'));
  startService();
});

/** A Station process on the shared store, with its own engine. */
function startService(): void {
  adapter = new AdoptingAdapter();
  service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore: store,
    adoptionLedger: store.createAdoptionLedger(),
    listProjects: () => projects,
    logger: { debug: () => {}, warn: () => {} },
  });
}

afterEach(async () => {
  await service.shutdown();
  for (const earlier of retired.splice(0)) await earlier.shutdown();
  store.close();
  vi.unstubAllEnvs();
});

let sources = 0;
/** A followed conversation whose recorded folder is `cwd`. */
function attached(cwd: string): string {
  sources += 1;
  const threadId = `external:claude:continue-${sources}`;
  store.upsertSession({
    provider: 'claude',
    threadId,
    status: 'ready',
    cwd,
    controlMode: 'read-only-attached',
    attachedSource: {
      kind: 'claude-transcript',
      externalSessionId: `native-${sources}`,
      affinity: { kind: 'test', ref: 'fixture' },
    },
    createdAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z',
  });
  return threadId;
}

function adopt(sourceThreadId: string, target?: AdoptSessionTarget) {
  const command: OrchestrationCommand = {
    type: 'adoptSession',
    sourceThreadId,
    ...(target ? { target } : {}),
  };
  return service.dispatch(command);
}

/** The child as Activity and the session list read it (its summary). */
async function childSummary(threadId: string, projectSlug?: string) {
  let found: OrchestrationSessionSummary | undefined;
  await vi.waitFor(async () => {
    found = (await service.readSession(threadId, INTERNAL_SESSION_READ_SCOPE))
      ?.session;
    expect(found?.threadId).toBe(threadId);
    expect(found?.projectSlug).toBe(projectSlug);
  });
  return found!;
}

describe('a conversation in a worktree outside the project folder (#3386)', () => {
  test('continues in that worktree, under the project, confined to it', async () => {
    writeFileSync(join(lane, 'inside.txt'), 'in the worktree');
    writeFileSync(join(dir, 'outside.txt'), 'beside the worktree');
    symlinkSync(join(dir, 'outside.txt'), join(lane, 'escape.txt'));
    const source = attached(lane);

    const result = (await adopt(source)) as { threadId: string };

    expect(adapter.adoptions).toHaveLength(1);
    const [input] = adapter.adoptions;
    // The engine starts in the worktree, confined to its working directory.
    expect(input!.cwd).toBe(lane);
    expect(input!.confinement).toBe('workspace');
    expect(input!.metadata).toMatchObject({
      stationConfinement: 'workspace',
      projectSlug: 'station',
      localProjectId: 'project-1',
    });
    const child = await childSummary(result.threadId, 'station');
    expect(child.cwd).toBe(lane);
    expect(child.controlMode).toBe('station-owned');
    expect(child.projectSlug).toBe('station');

    // Station's own file reads for this session: the worktree, verified
    // against the project's repository, and nothing outside it.
    const workspace = await sessionWorkspaceDirectoryFor(
      {
        canRead: () => true,
        listSessions: async () => [child],
        projectDirectory: async () => main,
      },
      'station',
      child.threadId,
    );
    expect(workspace).toBe(lane);
    const files = new FileTreeService();
    expect(files.readFileWithin(workspace!, 'inside.txt')).toBe(
      'in the worktree',
    );
    expect(() => files.readFileWithin(workspace!, '../outside.txt')).toThrow();
    expect(() => files.readFileWithin(workspace!, 'escape.txt')).toThrow();
    expect(() =>
      files.writeTextFileWithin(workspace!, '../planted.txt', 'x'),
    ).toThrow();
  });

  test('the same choice made explicitly is accepted; another project or No project is refused', async () => {
    projects.push({
      slug: 'beacon',
      workingDirectory: repository(join(dir, 'beacon')),
    });
    await expect(
      adopt(attached(lane), { kind: 'project', projectSlug: 'beacon' }),
    ).rejects.toThrow('belongs to the project station, not beacon');
    await expect(adopt(attached(lane), { kind: 'own-folder' })).rejects.toThrow(
      'belongs to the project station. Continue it in that project.',
    );
    expect(adapter.adoptions).toHaveLength(0);
    await adopt(attached(lane), { kind: 'project', projectSlug: 'station' });
    expect(adapter.adoptions.map((input) => input.cwd)).toEqual([lane]);
  });

  test('a worktree removed since it was discovered is refused', async () => {
    const source = attached(lane);
    git(main, 'worktree', 'remove', '--force', lane);

    await expect(adopt(source)).rejects.toThrow(
      "This conversation's folder no longer exists",
    );
    expect(adapter.adoptions).toHaveLength(0);
  });

  test('a worktree replaced by a symlink to a folder outside the repository is refused', async () => {
    const source = attached(lane);
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    rmSync(lane, { recursive: true, force: true });
    symlinkSync(elsewhere, lane);

    await expect(adopt(source)).rejects.toThrow(
      "This conversation's folder belongs to no project.",
    );
    // Not even as the project the conversation was filed under.
    await expect(
      adopt(source, { kind: 'project', projectSlug: 'station' }),
    ).rejects.toThrow('is not part of the project station');
    expect(adapter.adoptions).toHaveLength(0);
  });

  test('a folder whose .git names the project repository without being its worktree is refused', async () => {
    // A copy of the lane's `.git` file: it names the lane's real git
    // directory, whose back-pointer names the lane, not this folder.
    const forged = join(dir, 'forged');
    mkdirSync(forged);
    writeFileSync(
      join(forged, '.git'),
      `gitdir: ${join(main, '.git', 'worktrees', 'lane')}\n`,
    );
    const source = attached(forged);

    await expect(adopt(source)).rejects.toThrow(
      "This conversation's folder belongs to no project.",
    );
    await expect(
      adopt(source, { kind: 'project', projectSlug: 'station' }),
    ).rejects.toThrow('is not part of the project station');
    expect(adapter.adoptions).toHaveLength(0);
  });

  test('a worktree replaced after the first check, before the engine starts, is refused', async () => {
    const source = attached(lane);
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    adapter.onReadiness = () => {
      rmSync(lane, { recursive: true, force: true });
      symlinkSync(elsewhere, lane);
    };

    await expect(adopt(source)).rejects.toThrow(
      'Station could not continue this attached session. No continuation was kept.',
    );
    expect(adapter.adoptions).toHaveLength(0);
  });
});

describe('later messages to the continuation (#3386)', () => {
  // Activity's own session view sends each later message as `sendTurn` to
  // the child (useMutableSessionDetailState). These pin that route for the
  // three kinds of child. The chat dock's route is not covered: it cannot
  // open an adopted child's conversation (see the round's report).
  test.each([
    ['inside the project folder', () => main, undefined],
    ['in a worktree outside it', () => lane, undefined],
    [
      'with no project',
      () => join(dir, 'home', 'code', 'app'),
      { kind: 'own-folder' } as const,
    ],
  ])(
    'a child %s takes a second and third message in its own folder',
    async (_label, folder, target) => {
      const cwd = folder();
      mkdirSync(cwd, { recursive: true });
      const { threadId } = (await adopt(attached(cwd), target)) as {
        threadId: string;
      };
      for (const text of ['second message', 'third message'])
        await service.dispatch({
          type: 'sendTurn',
          input: { threadId, input: text },
        });
      expect(adapter.turns).toEqual([
        { threadId, input: 'second message' },
        { threadId, input: 'third message' },
      ]);
      expect(adapter.adoptions.map((input) => input.cwd)).toEqual([
        realpathSync.native(cwd),
      ]);
    },
  );
});

describe('after a restart (#3386)', () => {
  async function adoptedThenRestarted(): Promise<string> {
    const { threadId } = (await adopt(attached(lane))) as { threadId: string };
    await childSummary(threadId, 'station');
    // A process that ended without a clean shutdown (a clean one closes
    // its sessions): the child is still open, and the next process restores
    // it and starts its engine on the next turn.
    retired.push(service);
    startService();
    return threadId;
  }

  test('the child starts again in its worktree', async () => {
    const threadId = await adoptedThenRestarted();
    expect(store.readSessionByThread(threadId)?.cwd).toBe(lane);
    await service.dispatch({
      type: 'sendTurn',
      input: { threadId, input: 'carry on' },
    });
    expect(adapter.starts.map((input) => input.cwd)).toEqual([lane]);
  });

  test('a worktree swapped for a link since adoption is refused before the engine starts', async () => {
    const threadId = await adoptedThenRestarted();
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    rmSync(lane, { recursive: true, force: true });
    symlinkSync(elsewhere, lane);

    await expect(
      service.dispatch({
        type: 'sendTurn',
        input: { threadId, input: 'carry on' },
      }),
    ).rejects.toThrow(
      `Station will not start this session: it was admitted into ${lane}, and its working directory now resolves to ${elsewhere}.`,
    );
    expect(adapter.starts).toHaveLength(0);
  });
});

describe('a conversation no project claims (#3386)', () => {
  test('a folder refusal carries its code to callers', async () => {
    const folder = join(dir, 'outside');
    mkdirSync(folder);
    const error = await adopt(attached(folder), { kind: 'own-folder' }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: 'continuation_place_refused' });
  });

  test('is refused until the person chooses where it continues', async () => {
    const folder = join(dir, 'home', 'code', 'app');
    mkdirSync(folder, { recursive: true });
    await expect(adopt(attached(folder))).rejects.toThrow(
      "This conversation's folder belongs to no project. Choose to continue it as a No project chat",
    );
    expect(adapter.adoptions).toHaveLength(0);
  });

  test('continues as a No project chat confined to its own folder', async () => {
    const folder = join(dir, 'home', 'code', 'app');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(dir, 'home', 'code', 'secret.txt'), 'beside the folder');

    const result = (await adopt(attached(folder), {
      kind: 'own-folder',
    })) as { threadId: string };

    const [input] = adapter.adoptions;
    expect(input!.cwd).toBe(folder);
    expect(input!.confinement).toBe('workspace');
    expect(input!.metadata).not.toHaveProperty('projectSlug');
    expect(input!.metadata).not.toHaveProperty('localProjectId');
    const child = await childSummary(result.threadId);
    expect(child.cwd).toBe(folder);
    expect(child.projectSlug).toBeUndefined();
    expect(() =>
      new FileTreeService().readFileWithin(folder, '../secret.txt'),
    ).toThrow();
  });

  test('picking a project the folder does not belong to is refused, never moved there', async () => {
    const folder = join(dir, 'home', 'code', 'app');
    mkdirSync(folder, { recursive: true });
    await expect(
      adopt(attached(folder), { kind: 'project', projectSlug: 'station' }),
    ).rejects.toThrow(
      "This conversation's folder is not part of the project station",
    );
    expect(adapter.adoptions).toHaveLength(0);
  });

  /** A folder inside the test's home folder, created. */
  function inHome(...parts: string[]): string {
    const folder = join(dir, 'home', ...parts);
    mkdirSync(folder, { recursive: true });
    return folder;
  }

  test.each([
    ['the home folder', () => join(dir, 'home'), 'it is your home folder'],
    [
      'a folder containing the home folder',
      () => dir,
      'it is outside your home folder',
    ],
    ['the filesystem root', () => '/', 'it is outside your home folder'],
    // Real system folders, resolved as the host resolves them (on macOS
    // `/tmp` and `/etc` are links into `/private`, one level deeper).
    ['/tmp', () => '/tmp', 'it is outside your home folder'],
    ['/etc', () => '/etc', 'it is outside your home folder'],
    [
      '~/.ssh',
      () => inHome('.ssh', 'keys'),
      'it is inside ~/.ssh, a hidden folder where tools keep their settings and credentials',
    ],
    [
      '~/.claude',
      () => inHome('.claude', 'projects'),
      'it is inside ~/.claude, a hidden folder',
    ],
    [
      '~/Library',
      () => inHome('Library', 'Application Support'),
      'it is inside ~/Library, where the system keeps application data',
    ],
    [
      'a link in the home folder that leads outside it',
      () => {
        const outside = join(dir, 'outside');
        mkdirSync(outside);
        inHome('code');
        symlinkSync(outside, join(dir, 'home', 'code', 'link'));
        return join(dir, 'home', 'code', 'link');
      },
      `it is outside your home folder`,
    ],
    [
      "Station's data folder",
      () => inHome('station-data', 'logs'),
      "it is or overlaps Station's own data folder",
    ],
  ])('refuses a No project chat in %s', async (_label, folder, reason) => {
    await expect(
      adopt(attached(folder()), { kind: 'own-folder' }),
    ).rejects.toThrow(reason);
    expect(adapter.adoptions).toHaveLength(0);
  });

  // Transcripts record the folder as the shell spelled it. On a file system
  // that ignores letter case or Unicode normalization, another spelling of
  // the same folder is that folder, not a link to somewhere else.
  const sameFolderSpellings = [
    ['letter case', 'code/app', 'Code/App'],
    ['Unicode normalization', 'caf\u00e9', 'cafe\u0301'],
  ] as const;
  test.each(sameFolderSpellings)(
    'a recorded folder spelled with a different %s is the same folder',
    async (_label, onDisk, spelled) => {
      const folder = inHome(...onDisk.split('/'));
      const recorded = join(dir, 'home', ...spelled.split('/'));
      // Only meaningful where the file system resolves that spelling.
      if (!existsSync(recorded)) return;
      await adopt(attached(recorded), { kind: 'own-folder' });
      expect(adapter.adoptions.map((input) => input.cwd)).toEqual([
        realpathSync.native(folder),
      ]);
    },
  );

  test('refuses a No project chat whose recorded folder leads elsewhere in the home folder', async () => {
    const real = inHome('code', 'real');
    symlinkSync(real, join(dir, 'home', 'code', 'shown'));
    const shown = join(dir, 'home', 'code', 'shown');
    await expect(
      adopt(attached(shown), { kind: 'own-folder' }),
    ).rejects.toThrow(
      "This conversation's folder leads to another folder through a symbolic link.",
    );
    expect(adapter.adoptions).toHaveLength(0);
    // The folder it leads to is allowed when the conversation recorded it.
    await adopt(attached(real), { kind: 'own-folder' });
    expect(adapter.adoptions.map((input) => input.cwd)).toEqual([real]);
  });
});

describe('the folder rules themselves', () => {
  test('only a folder inside the home folder, outside its hidden and system folders, is allowed', () => {
    const home = join(dir, 'home');
    expect(noProjectFolderRefusal(join(home, 'code', 'foo'))).toBeUndefined();
    expect(noProjectFolderRefusal(join(home, 'Documents'))).toBeUndefined();
    expect(noProjectFolderRefusal(join(home, '.aws'))).toBeDefined();
    expect(noProjectFolderRefusal(join(home, '.config', 'gh'))).toBeDefined();
    expect(noProjectFolderRefusal(join(home, 'library', 'x'))).toBeDefined();
    expect(
      noProjectFolderRefusal(join(home, 'AppData', 'Roaming')),
    ).toBeDefined();
    expect(noProjectFolderRefusal(realpathSync.native('/tmp'))).toBe(
      'it is outside your home folder',
    );
    expect(noProjectFolderRefusal(realpathSync.native(tmpdir()))).toBe(
      'it is outside your home folder',
    );
    expect(noProjectFolderRefusal('/usr/local')).toBe(
      'it is outside your home folder',
    );
  });

  test('a hosted Station never continues a conversation outside every project', async () => {
    const folder = join(dir, 'scratch');
    mkdirSync(folder);
    await expect(
      resolveContinuationPlace({
        cwd: folder,
        projects,
        target: { kind: 'own-folder' },
        hosted: true,
      }),
    ).rejects.toThrow('This Station is hosted');
  });
});
