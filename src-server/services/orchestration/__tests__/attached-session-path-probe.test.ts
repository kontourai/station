/**
 * #3406: attached-session discovery reads session and project folders in a
 * helper process with a deadline, so a folder on a hung mount neither stalls
 * a poll past the deadline nor blocks Station's event loop.
 *
 * A hung mount is stood in for by the fixture child, which blocks in a real
 * `open` syscall on a FIFO for any folder holding a `.hang` FIFO: a call no
 * JavaScript timer can interrupt, as a hung NFS `realpath` would be.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { AttachedSessionSource } from '../../../providers/sessions/attached-session-source.js';
import { AttachedSessionFollowService } from '../attached-session-follow-service.js';
import { AttachedPathProbe } from '../attached-session-path-probe.js';
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

beforeEach(() => {
  dir = realpathSync.native(tempDir('station-attached-path-'));
});

afterEach(() => {
  for (const probe of probes.splice(0)) probe.dispose();
});

function probe(
  options: ConstructorParameters<typeof AttachedPathProbe>[0] = {},
): AttachedPathProbe {
  const created = new AttachedPathProbe({
    childEntry: HANGING_CHILD,
    deadlineMs: DEADLINE_MS,
    ...options,
  });
  probes.push(created);
  return created;
}

/** A folder whose reads block the fixture child, like one on a hung mount. */
function hungFolder(path: string): string {
  mkdirSync(path, { recursive: true });
  execFileSync('mkfifo', [join(path, '.hang')], { windowsHide: true });
  return path;
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
      const reader = probe({ backoffMs: 60_000, now: () => clock });
      const hung = hungFolder(join(dir, 'hung'));
      expect(await reader.canonical(hung)).toBeUndefined();

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
          settle('timeout');
        }, 30_000);
        child.once('exit', (code) => {
          clearTimeout(timer);
          settle(code);
        });
      });
      expect(exit, stderr).toBe(0);
      // The probe's own log lines share stdout; the answers are tagged.
      const answers = /^ANSWERS (.*)$/m.exec(stdout)?.[1];
      expect(answers && JSON.parse(answers)).toEqual([null, dir]);
    }, 40_000);
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
  },
);
