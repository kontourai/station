/**
 * #4771: the runtime's Session-exit handler runs the worktree cleanup policy
 * through the settlement service, so a worktree it removes without a
 * decision is recorded as exactly that. A real runtime, a real repository
 * and the runtime's own orchestration store; the exit arrives on the bus the
 * way the orchestration service publishes it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { expect, test } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { WorktreeProvisioningService } from '../../../services/projects/worktree-provisioning-service.js';
import { StationRuntime } from '../station-runtime.js';

const makeTempDir = trackTempDirs();

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Station Test',
      GIT_AUTHOR_EMAIL: 'test@station.invalid',
      GIT_COMMITTER_NAME: 'Station Test',
      GIT_COMMITTER_EMAIL: 'test@station.invalid',
    },
    windowsHide: true,
  }).trim();
}

test('a Session exit that removes its worktree with no decision records cleaned-up-without-decision', async () => {
  const parent = realpathSync(makeTempDir('runtime-worktree-exit-'));
  const repo = join(parent, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(repo, 'README.md'), 'project\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '--quiet', '-m', 'initial');
  const sessionId = 'exit-session';
  const metadata = await new WorktreeProvisioningService().provision({
    repoPath: repo,
    threadId: sessionId,
    providerKind: 'claude',
    isolation: { mode: 'worktree', policy: { cleanupOnCompletion: true } },
  });
  if (!metadata) throw new Error('no worktree');
  const head = git(metadata.path, 'rev-parse', 'HEAD');

  const runtime = new StationRuntime({
    projectHomeDir: makeTempDir('runtime-worktree-exit-home-'),
    port: 43198,
    logLevel: 'error',
  });
  let orchestration: OrchestrationService | undefined;
  try {
    const store = runtime['orchestrationEventStore'];
    // The runtime composes its orchestration service at start; this test
    // supplies one over the runtime's own store, as the cascade test does.
    orchestration = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(new GateTestAdapter()),
      eventBus: new EventBus(),
      eventStore: store,
      logger: { debug() {}, warn() {} },
    });
    runtime['orchestrationService'] = orchestration;
    const now = new Date().toISOString();
    store.upsertSession({
      provider: 'claude',
      threadId: sessionId,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    });
    store.appendEvent({
      eventId: 'exit-session-started',
      threadId: sessionId,
      sessionId,
      provider: 'claude',
      method: 'session.started',
      createdAt: now,
      metadata: { worktree: metadata },
    } as never);
    const exited = {
      eventId: 'exit-session-exited',
      threadId: sessionId,
      sessionId,
      provider: 'claude',
      method: 'session.exited',
      exitCode: 0,
      createdAt: now,
    };
    store.appendEvent(exited as never);

    runtime['eventBus'].emit(SERVER_EVENTS.ORCHESTRATION_EVENT, {
      event: exited,
    });

    const settlements = store.worktreeOutputSettlementStore();
    const deadline = Date.now() + 20_000;
    while (!settlements.read(sessionId) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));

    expect(settlements.read(sessionId)?.record).toMatchObject({
      sessionId,
      state: 'settled',
      outcome: 'cleaned-up-without-decision',
      actor: { kind: 'station', id: 'worktree-cleanup-policy' },
      branch: metadata.branch,
      headCommit: head,
      evidence: { terminalState: 'completed' },
    });
    expect(existsSync(metadata.path)).toBe(false);
  } finally {
    await orchestration?.shutdown();
    await runtime.shutdown();
  }
});
