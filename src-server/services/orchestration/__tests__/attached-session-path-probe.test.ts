/**
 * #3406: attached-session discovery reads session and project folders in a
 * helper process with a deadline, so a folder on a hung mount neither stalls
 * a poll past the deadline nor blocks Station's event loop.
 *
 * A hung mount is stood in for by the fixture child, which blocks in a real
 * `open` syscall on a FIFO for any folder holding a `.hang` FIFO: a call no
 * JavaScript timer can interrupt, as a hung NFS `realpath` would be.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { AttachedSessionSource } from '../../../providers/sessions/attached-session-source.js';
import { AttachedSessionFollowService } from '../attached-session-follow-service.js';
import {
  AttachedPathProbe,
  closeSharedAttachedPathProbe,
  sharedAttachedPathProbe,
} from '../attached-session-path-probe.js';
import { locateRepository } from '../attached-session-repository.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import type { SessionAnswerabilityObservation } from '../open-requests.js';
import { buildOrchestrationSessionSummary } from '../orchestration-session-state.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  orchestrationEventsPersisted: { add: vi.fn() },
  orchestrationEventPersistDuration: { record: vi.fn() },
  attachedSessionDiscovery: { add: vi.fn() },
  attachedSessionScanDuration: { record: vi.fn() },
  attachedSessionEventsImported: { add: vi.fn() },
  attachedSessionProjectAttribution: { add: vi.fn() },
  sessionOwnerCacheOps: { add: vi.fn() },
}));

const HANGING_CHILD = new URL(
  './fixtures/attached-session-hanging-path-child.ts',
  import.meta.url,
);
const PROBE_MODULE = fileURLToPath(
  new URL('../attached-session-path-probe.ts', import.meta.url),
);
const DEADLINE_MS = 800;
const OBSERVATION: SessionAnswerabilityObservation = {
  threadAttachment: 'detached',
  providerRegistered: true,
  observedBy: 'test-instance#0',
  observedAt: '2026-08-03T00:00:00.000Z',
};

const tempDir = trackTempDirs();
let dir: string;
const probes: AttachedPathProbe[] = [];
const helpers: number[] = [];
const fifos: string[] = [];

beforeEach(() => {
  dir = realpathSync.native(tempDir('station-attached-path-'));
});

// Registered after the temp-dir tracker, so it runs before the directories
// are removed: a helper blocked on a FIFO is released, and every helper
// started is gone, even when a test failed or timed out.
afterEach(() => {
  for (const probe of probes.splice(0)) probe.close();
  releaseFifos();
  for (const pid of helpers.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

/** Opens each `.hang` FIFO for writing, which lets a reader blocked on it go on. */
function releaseFifos(): void {
  for (const fifo of fifos.splice(0)) {
    try {
      closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
    } catch {
      // No reader is blocked on it (ENXIO), or it was removed.
    }
  }
}

function probe(
  options: ConstructorParameters<typeof AttachedPathProbe>[0] = {},
): AttachedPathProbe {
  const created = new AttachedPathProbe({
    childEntry: HANGING_CHILD,
    deadlineMs: DEADLINE_MS,
    ...options,
    onSpawn: (child) => {
      if (child.pid !== undefined) helpers.push(child.pid);
      options.onSpawn?.(child);
    },
  });
  probes.push(created);
  return created;
}

/** A folder whose reads block the fixture child, like one on a hung mount. */
function hungFolder(path: string): string {
  mkdirSync(path, { recursive: true });
  const fifo = join(path, '.hang');
  execFileSync('mkfifo', [fifo], { windowsHide: true });
  fifos.push(fifo);
  return path;
}

async function exitOf(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null)
    await once(child, 'exit');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Runs a module script that imports the probe; its `HELPER <pid>` lines are collected. */
async function runScript(script: string): Promise<{
  exit: number | null | 'timeout';
  stdout: string;
  stderr: string;
  helperPids: number[];
}> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exit = await new Promise<number | null | 'timeout'>((settle) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      // Its helper may be blocked on a FIFO; let it go on and see the
      // channel close.
      releaseFifos();
      settle('timeout');
    }, 30_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      settle(code);
    });
  });
  const helperPids = [...stdout.matchAll(/^HELPER (\d+)$/gm)].map((match) =>
    Number(match[1]),
  );
  helpers.push(...helperPids);
  return { exit, stdout, stderr, helperPids };
}

describe.skipIf(process.platform === 'win32')(
  'attached-session path probe (#3406)',
  () => {
    test('a readable folder gets exactly the answers the in-process reads give', async () => {
      const reader = probe();
      const real = join(dir, 'real');
      mkdirSync(join(real, 'packages', 'app'), { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'main'], {
        cwd: real,
        stdio: 'ignore',
        windowsHide: true,
      });
      const link = join(dir, 'link');
      symlinkSync(real, link);
      const nested = join(link, 'packages', 'app');

      expect(await reader.canonical(nested)).toBe(realpathSync.native(nested));
      expect(await reader.canonical(join(dir, 'missing'))).toBeUndefined();
      const located = await reader.repository(realpathSync.native(nested));
      expect(located).toEqual(await locateRepository(nested));
      expect(located?.pathInWorktree).toBe(join('packages', 'app'));
      expect(await reader.repository(dir)).toBeUndefined();
    });

    test('a hung folder answers unresolved at the deadline, and the next request gets a fresh child', async () => {
      const reader = probe();
      const hung = hungFolder(join(dir, 'hung'));
      const started = performance.now();
      expect(await reader.canonical(hung)).toBeUndefined();
      const waited = performance.now() - started;
      // It was really asked and really blocked, then given up on.
      expect(waited).toBeGreaterThanOrEqual(DEADLINE_MS - 20);
      expect(waited).toBeLessThan(DEADLINE_MS + 5_000);
      expect(await reader.canonical(dir)).toBe(dir);
    });

    test('a hung folder is not asked about again until its back-off ends', async () => {
      let clock = 0;
      const spawned: ChildProcess[] = [];
      const reader = probe({
        backoffMs: 60_000,
        now: () => clock,
        onSpawn: (child) => spawned.push(child),
      });
      const hung = hungFolder(join(dir, 'hung'));
      expect(await reader.canonical(hung)).toBeUndefined();
      // The killed helper's exit is observed, so only the back-off holds.
      await exitOf(spawned[0]!);

      const started = performance.now();
      expect(await reader.canonical(hung)).toBeUndefined();
      expect(performance.now() - started).toBeLessThan(DEADLINE_MS / 2);

      rmSync(join(hung, '.hang'));
      expect(await reader.canonical(hung)).toBeUndefined();
      clock = 60_000;
      expect(await reader.canonical(hung)).toBe(hung);
    });

    test('a child that cannot start answers unresolved instead of hanging', async () => {
      const reader = probe({
        childEntry: new URL('file:///nonexistent/attached-path-child.mjs'),
      });
      expect(await reader.canonical(dir)).toBeUndefined();
      expect(await reader.canonical(dir)).toBeUndefined();
    });

    test('a process whose child hung still exits on its own', async () => {
      const hung = hungFolder(join(dir, 'hung'));
      const script = `
      const { AttachedPathProbe } = await import(${JSON.stringify(PROBE_MODULE)});
      const reader = new AttachedPathProbe({
        childEntry: new URL(${JSON.stringify(HANGING_CHILD.href)}),
        deadlineMs: ${DEADLINE_MS},
      });
      const answers = [await reader.canonical(${JSON.stringify(hung)}), await reader.canonical(${JSON.stringify(dir)})];
      console.log('ANSWERS ' + JSON.stringify(answers));
    `;
      const { exit, stdout, stderr } = await runScript(script);
      expect(exit, stderr).toBe(0);
      // The probe's own log lines share stdout; the answers are tagged.
      const answers = /^ANSWERS (.*)$/m.exec(stdout)?.[1];
      expect(answers && JSON.parse(answers)).toEqual([null, dir]);
    }, 40_000);

    test('a process that exits while its helper is stuck leaves no helper alive', async () => {
      const hung = hungFolder(join(dir, 'hung'));
      // The read is still pending, far inside its deadline, when the process
      // calls process.exit(): the helper, blocked on the FIFO, never sees its
      // channel close, so only the probe's exit hook can end it.
      const script = `
      const { AttachedPathProbe } = await import(${JSON.stringify(PROBE_MODULE)});
      const reader = new AttachedPathProbe({
        childEntry: new URL(${JSON.stringify(HANGING_CHILD.href)}),
        deadlineMs: 60000,
        onSpawn: (child) => console.log('HELPER ' + child.pid),
      });
      await reader.canonical(${JSON.stringify(dir)});
      void reader.canonical(${JSON.stringify(hung)});
      setTimeout(() => process.exit(0), 500);
    `;
      const { exit, stderr, helperPids } = await runScript(script);
      expect(exit, stderr).toBe(0);
      expect(helperPids).toHaveLength(1);
      const [helper] = helperPids;
      const deadline = Date.now() + 5_000;
      while (alive(helper!) && Date.now() < deadline) {
        await new Promise((settle) => setTimeout(settle, 50));
      }
      expect(alive(helper!)).toBe(false);
    }, 40_000);

    test('a main thread blocked past the deadline does not make a healthy folder look hung', async () => {
      const spawned: ChildProcess[] = [];
      const reader = probe({ onSpawn: (child) => spawned.push(child) });
      expect(await reader.canonical(dir)).toBe(dir);
      const answer = reader.canonical(dir);
      // Let the request reach the helper (it is sent from a microtask), then
      // hold this thread past the deadline while the helper answers.
      for (let turn = 0; turn < 10; turn += 1) await null;
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        DEADLINE_MS * 2,
      );
      expect(await answer).toBe(dir);
      // Not backed off, and the same helper still answers.
      expect(await reader.canonical(dir)).toBe(dir);
      expect(spawned).toHaveLength(1);
    });

    test('a helper that survives its kill is counted as stuck: its folder is not retried while it lives, and no helper starts past the limit', async () => {
      const spawned: ChildProcess[] = [];
      let clock = 0;
      const reader = probe({
        backoffMs: 1_000,
        now: () => clock,
        maxStuckChildren: 1,
        // A process in an uninterruptible read on a hard NFS mount ignores
        // SIGKILL; a FIFO reader cannot, so the kill itself is withheld.
        killChild: () => {},
        onSpawn: (child) => spawned.push(child),
      });
      const hung = hungFolder(join(dir, 'hung'));
      expect(await reader.canonical(hung)).toBeUndefined();
      clock = 10_000;
      // Past its back-off, but the helper stuck on it is alive: not asked.
      expect(await reader.canonical(hung)).toBeUndefined();
      // And with one stuck helper at a limit of one, no new helper starts.
      expect(await reader.canonical(dir)).toBeUndefined();
      expect(spawned).toHaveLength(1);

      // The stuck helper finally exits: a new one starts and the folder,
      // which answers again, is read.
      const [first] = spawned;
      const exited = once(first!, 'exit');
      first!.kill('SIGKILL');
      await exited;
      rmSync(join(hung, '.hang'));
      expect(await reader.canonical(dir)).toBe(dir);
      expect(await reader.canonical(hung)).toBe(hung);
      expect(spawned).toHaveLength(2);
    });

    test('at the stuck-helper limit only folders under a stuck one are unread; others read by their path as written, never their real path', async () => {
      const spawned: ChildProcess[] = [];
      const reader = probe({
        maxStuckChildren: 1,
        killChild: () => {},
        onSpawn: (child) => spawned.push(child),
      });
      const hung = hungFolder(join(dir, 'hung'));
      mkdirSync(join(hung, 'sub'));
      // A sibling whose name merely starts with the stuck folder's.
      const sibling = join(dir, 'hung-other');
      mkdirSync(sibling);
      mkdirSync(join(dir, 'target'));
      const link = join(dir, 'link');
      symlinkSync(join(dir, 'target'), link);
      expect(await reader.canonical(hung)).toBeUndefined();

      const paths = reader.forPoll();
      await paths.prepare([
        join(hung, 'sub'),
        sibling,
        link,
        join(dir, 'elsewhere'),
      ]);
      expect(paths.canonical(join(hung, 'sub'))).toBeUndefined();
      expect(paths.canonical(sibling)).toBe(sibling);
      expect(paths.canonical(link)).toBe(link);
      expect(paths.canonical(join(dir, 'elsewhere'))).toBe(
        join(dir, 'elsewhere'),
      );
      expect(await paths.repository(dir)).toBeUndefined();
      expect(spawned).toHaveLength(1);
    });

    test('a closed probe answers unread and starts no helper, even for a request already in flight', async () => {
      const spawned: ChildProcess[] = [];
      const reader = probe({ onSpawn: (child) => spawned.push(child) });
      const inFlight = reader.canonical(dir);
      reader.close();
      expect(await inFlight).toBeUndefined();
      expect(await reader.canonical(dir)).toBeUndefined();
      expect(spawned.length).toBeLessThanOrEqual(1);

      const before = sharedAttachedPathProbe();
      closeSharedAttachedPathProbe();
      expect(await before.canonical(dir)).toBeUndefined();
      const after = sharedAttachedPathProbe();
      expect(after).not.toBe(before);
      closeSharedAttachedPathProbe();
    });
  },
);

describe.skipIf(process.platform === 'win32')(
  'a poll with a session folder on a hung mount (#3406)',
  () => {
    let store: EventStore;

    beforeEach(() => {
      store = new EventStore(join(dir, 'orchestration.sqlite'));
    });

    afterEach(() => store.close());

    function sessionIn(name: string, cwd: string) {
      return {
        provider: 'claude',
        sessionId: name,
        threadId: `external:claude:${name}`,
        cwd,
        createdAt: '2026-07-22T00:00:00.000Z',
        sourceHandle: `handle-${name}`,
      };
    }

    function sourceOf(
      sessions: ReturnType<typeof sessionIn>[],
    ): AttachedSessionSource {
      return {
        provider: 'claude',
        kind: 'claude-transcript',
        discover: vi.fn().mockResolvedValue({ outcome: 'ok', sessions }),
        read: vi.fn().mockImplementation(async (session) => ({
          outcome: 'ok',
          events: [
            {
              eventId: `${session.sessionId}-event-1`,
              provider: 'claude',
              threadId: session.threadId,
              createdAt: '2026-07-22T00:00:01.000Z',
              method: 'content.text-delta',
              itemId: 'item-1',
              delta: 'hello',
            },
          ],
          cursor: 1,
        })),
      };
    }

    function projectOf(threadId: string): string | undefined {
      const persisted = store
        .readSessions()
        .find((item) => item.threadId === threadId);
      if (!persisted) throw new Error(`${threadId} was never persisted`);
      return buildOrchestrationSessionSummary({
        answerability: OBSERVATION,
        persisted,
        events: store
          .listEvents(threadId)
          .map((item) => item.payload as unknown as CanonicalRuntimeEvent),
      }).projectSlug;
    }

    test('finishes within the deadline without blocking the event loop, attributes the readable session, and corrects the hung one once it answers', async () => {
      const alpha = join(dir, 'alpha');
      mkdirSync(join(alpha, 'readable'), { recursive: true });
      const hung = hungFolder(join(alpha, 'hung'));
      // Both sessions sit in alpha only by their real paths: lexically they
      // are outside it, so an answer read off the main thread is what
      // attributes them.
      const readableLink = join(dir, 'readable-link');
      symlinkSync(join(alpha, 'readable'), readableLink);
      const hungLink = join(dir, 'hung-link');
      symlinkSync(hung, hungLink);
      const readable = sessionIn('readable', readableLink);
      const stuck = sessionIn('stuck', hungLink);

      let clock = 0;
      const reader = probe({ backoffMs: 60_000, now: () => clock });
      // Start the child outside the measurement; a dev `tsx` start is slow.
      expect(await reader.canonical(dir)).toBe(dir);
      const service = new AttachedSessionFollowService({
        sources: [sourceOf([readable, stuck])],
        eventStore: store,
        eventBus: new EventBus(),
        listProjects: () => [{ slug: 'alpha', workingDirectory: alpha }],
        pathProbe: reader,
        followUnattributed: true,
      });

      const delay = monitorEventLoopDelay({ resolution: 5 });
      delay.enable();
      const started = performance.now();
      await service.pollNow();
      const elapsed = performance.now() - started;
      delay.disable();

      // The hung read was reached and waited on for the deadline...
      expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 20);
      expect(elapsed).toBeLessThan(DEADLINE_MS + 5_000);
      // ...without the event loop being held for it.
      expect(delay.max / 1e6).toBeLessThan(DEADLINE_MS / 2);
      expect(projectOf(readable.threadId)).toBe('alpha');
      expect(projectOf(stuck.threadId)).toBeUndefined();

      // Within its back-off the hung folder costs the poll nothing. (The hung
      // child was killed; start its replacement outside the measurement.)
      expect(await reader.canonical(dir)).toBe(dir);
      const again = performance.now();
      await service.pollNow();
      expect(performance.now() - again).toBeLessThan(DEADLINE_MS / 2);
      expect(projectOf(stuck.threadId)).toBeUndefined();

      // The mount answers again and the back-off ends: the next poll reads the
      // folder and corrects the session's attribution.
      rmSync(join(hung, '.hang'));
      clock = 60_000;
      await service.pollNow();
      expect(projectOf(stuck.threadId)).toBe('alpha');
      expect(projectOf(readable.threadId)).toBe('alpha');
    }, 60_000);

    test('an unread folder takes no part in matching: its Project is not matched and its session files under no Project by its path as written', async () => {
      const alpha = join(dir, 'alpha');
      mkdirSync(join(alpha, 'readable'), { recursive: true });
      // A Project folder that hangs. The fixture hangs only on the folder
      // holding the FIFO, so the session folder below it reads normally.
      const beta = hungFolder(join(dir, 'beta'));
      mkdirSync(join(beta, 'sub'));
      const inAlpha = sessionIn('in-alpha', join(alpha, 'readable'));
      const underUnreadRoot = sessionIn('under-beta', join(beta, 'sub'));
      // A session folder that hangs, whose path as written is inside alpha.
      const unreadInAlpha = sessionIn(
        'unread-in-alpha',
        hungFolder(join(alpha, 'unread')),
      );
      const service = new AttachedSessionFollowService({
        sources: [sourceOf([inAlpha, underUnreadRoot, unreadInAlpha])],
        eventStore: store,
        eventBus: new EventBus(),
        listProjects: () => [
          { slug: 'alpha', workingDirectory: alpha },
          { slug: 'beta', workingDirectory: beta },
        ],
        pathProbe: probe(),
        followUnattributed: true,
      });
      await service.pollNow();

      expect(projectOf(inAlpha.threadId)).toBe('alpha');
      // Matching beta by the path as written would say 'beta' here.
      expect(projectOf(underUnreadRoot.threadId)).toBeUndefined();
      // Matching the session by its path as written would say 'alpha'.
      expect(projectOf(unreadInAlpha.threadId)).toBeUndefined();
    }, 60_000);

    test('with sessions outside projects not followed, a session whose folder turns unreadable keeps its project and keeps importing', async () => {
      const alpha = join(dir, 'alpha');
      const cwd = join(alpha, 'work');
      mkdirSync(cwd, { recursive: true });
      const session = sessionIn('kept', cwd);
      let written = 1;
      const source: AttachedSessionSource = {
        provider: 'claude',
        kind: 'claude-transcript',
        discover: vi
          .fn()
          .mockResolvedValue({ outcome: 'ok', sessions: [session] }),
        read: vi.fn().mockImplementation(async (_session, cursor) => {
          const from = typeof cursor === 'number' ? cursor : 0;
          return {
            outcome: 'ok',
            cursor: written,
            events: Array.from({ length: written - from }, (_, index) => ({
              eventId: `kept-event-${from + index + 1}`,
              provider: 'claude',
              threadId: session.threadId,
              createdAt: `2026-07-22T00:00:0${from + index + 1}.000Z`,
              method: 'content.text-delta',
              itemId: `item-${from + index + 1}`,
              delta: 'hello',
            })),
          };
        }),
      };
      const service = new AttachedSessionFollowService({
        sources: [source],
        eventStore: store,
        eventBus: new EventBus(),
        listProjects: () => [{ slug: 'alpha', workingDirectory: alpha }],
        pathProbe: probe(),
        followUnattributed: false,
      });
      await service.pollNow();
      expect(projectOf(session.threadId)).toBe('alpha');

      // The folder stops answering, and the transcript grows.
      hungFolder(cwd);
      written = 2;
      await service.pollNow();
      expect(projectOf(session.threadId)).toBe('alpha');
      expect(
        store.listEvents(session.threadId).map((event) => event.id),
      ).toContain('kept-event-2');
    }, 60_000);
  },
);
