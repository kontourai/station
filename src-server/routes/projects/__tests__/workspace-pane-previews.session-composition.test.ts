/**
 * #3412: a file preview that names a Codex session reads that session's own
 * worktree through the PRODUCTION composition — a real `OrchestrationService`
 * over a real `CodexAdapter` (driven through a fake app-server child) and a
 * real `EventStore`, wired by the same `orchestrationSessionWorkspaceDirectory`
 * the runtime routes use. No fixture hands the lookup a `projectSlug`: the
 * project comes from what the session itself recorded at its start.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type SessionReadAuthority,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  emit,
  FakeCodexProcess,
  flushIo,
  withTimeout,
} from '../../../providers/__tests__/codex-adapter-wire-harness.js';
import { CodexAdapter } from '../../../providers/adapters/codex-adapter.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { orchestrationSessionWorkspaceDirectory } from '../../../services/projects/session-workspace-directory.js';
import { createWorkspacePanePreviewRoutes } from '../workspace-pane-previews.js';

const OWNER = 'human:local:owner';
const tempDir = trackTempDirs();
const services: OrchestrationService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
});

function gitCheckoutWithWorktree(root: string) {
  const checkout = join(root, 'repo');
  const worktree = join(root, 'repo-worktrees', 'lane');
  mkdirSync(checkout, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: checkout,
      stdio: 'ignore',
      windowsHide: true,
    });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(checkout, 'app.ts'), 'checkout copy');
  git('add', 'app.ts');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'i');
  git('worktree', 'add', '-q', '-b', 'lane', worktree);
  writeFileSync(join(worktree, 'app.ts'), 'worktree copy');
  return { checkout, worktree };
}

async function startCodexSession(
  service: OrchestrationService,
  process: FakeCodexProcess,
  input: { threadId: string; cwd: string; projectSlug: string },
) {
  const start = service.dispatch({
    type: 'startSession',
    input: {
      provider: 'codex',
      threadId: input.threadId,
      cwd: input.cwd,
      metadata: { projectSlug: input.projectSlug, userId: OWNER },
    },
  });
  await flushIo();
  await emit(process, { id: '1', result: { userAgent: 'test' } });
  await emit(process, {
    id: '2',
    result: { thread: { id: `codex-${input.threadId}` } },
  });
  await withTimeout(start, 'startSession');
}

async function composition() {
  const root = realpathSync(tempDir('station-preview-session-'));
  const { checkout, worktree } = gitCheckoutWithWorktree(root);
  const processes = [new FakeCodexProcess(), new FakeCodexProcess()];
  const spawned = [...processes];
  const adapter = new CodexAdapter({
    processFactory: () => processes.shift()! as never,
  });
  vi.spyOn(adapter, 'getPrerequisites').mockResolvedValue([]);
  const service = new OrchestrationService({
    adapterRegistry: {
      get: (provider) => (provider === 'codex' ? adapter : undefined),
      list: () => [adapter],
      register: () => {},
    },
    eventBus: new EventBus(),
    eventStore: new EventStore(join(root, 'orchestration.sqlite')),
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  services.push(service);
  await startCodexSession(service, spawned[0]!, {
    threadId: 'codex-lane',
    cwd: worktree,
    projectSlug: 'alpha',
  });
  await startCodexSession(service, spawned[1]!, {
    threadId: 'codex-beta',
    cwd: worktree,
    projectSlug: 'beta',
  });

  // The request's read authority, as the runtime's middleware resolves it.
  const authorities = new WeakMap<Request, SessionReadAuthority>();
  let reader = OWNER;
  const app = new Hono();
  app.use('*', async (c, next) => {
    authorities.set(
      c.req.raw,
      sessionReadAuthorityFromRequest(reader, undefined, undefined),
    );
    await next();
  });
  const directory = orchestrationSessionWorkspaceDirectory({
    sessions: service,
    authorityFor: (request) => authorities.get(request)!,
    projects: {
      getProject: (slug) => {
        if (slug !== 'alpha' && slug !== 'beta') throw new Error('Not found');
        return { workingDirectory: checkout };
      },
    },
  });
  app.route(
    '/:slug/file-preview',
    createWorkspacePanePreviewRoutes(
      {
        getProject: (slug: string) => {
          if (slug !== 'alpha') throw new Error('Not found');
          return { workingDirectory: checkout };
        },
      } as never,
      undefined,
      (c, slug, thread) => directory(c.req.raw, slug, thread),
    ),
  );
  const preview = (body: unknown) =>
    app.request('/alpha/file-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    preview,
    readAs: (userId: string) => {
      reader = userId;
    },
  };
}

describe('file preview for an engine session through the runtime composition (#3412)', () => {
  test('a Codex session previews its own worktree copy', async () => {
    const { preview } = await composition();
    const response = await preview({ path: 'app.ts', thread: 'codex-lane' });
    expect(response.status).toBe(200);
    expect((await json(response)).data).toMatchObject({
      content: 'worktree copy',
    });
  });

  test('another project’s session, an unknown one, or one the reader may not read is refused', async () => {
    const { preview, readAs } = await composition();
    for (const thread of ['codex-beta', 'ghost']) {
      const response = await preview({ path: 'app.ts', thread });
      expect(response.status).toBe(404);
      expect(JSON.stringify(await json(response))).not.toContain('copy');
    }
    readAs('human:local:stranger');
    const stranger = await preview({ path: 'app.ts', thread: 'codex-lane' });
    expect(stranger.status).toBe(404);
    expect(JSON.stringify(await json(stranger))).not.toContain('copy');
  });
});
