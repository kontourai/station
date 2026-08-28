/**
 * The watcher arming gap (archive#952), and the bounded reconciliation that closes it.
 *
 * `chokidar` emits `ready` when *its own* initial directory scan finishes, not
 * when the platform's notification stream goes live. A directory created in
 * that gap is lost outright, not delayed: on macOS every `fs.watch` handle in a
 * process shares one libuv FSEvents stream, and such a stream only reports from
 * the moment it starts. Measured on this repo against the production watcher's
 * exact options — same three roots, `depth: 1`, `ignoreInitial: true` — a
 * subdirectory created immediately after `ready`:
 *
 *   30 rounds idle:            1 never reported within 6s
 *   30 rounds under churn:    20 stalled at 1.2s, and 12 of those never
 *                             arrived within a further 10s
 *   in every non-delivering round the directory was absent from `getWatched()`
 *
 * That last line is why this is permanent rather than slow. chokidar caches
 * directory listings; if it never learns the subdirectory exists it never
 * watches it, so no later write inside it produces anything either.
 *
 * These tests therefore do not race the real stream — a test that reproduces a
 * 12%-of-the-time loss is a test that fails 12% of the time. They substitute a
 * watcher that models the *measured* failure exactly (`ready` fires, nothing is
 * ever delivered, the new directory never enters the watched map) and assert
 * that `ConfigLoader` reports the change anyway. Everything under test is
 * production code: the seeding, the scan, the diff, the re-arm, and the same
 * `notifyConfigFileEvent` path a live event takes. Only chokidar is replaced,
 * and only to make its documented worst case deterministic.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A watcher that goes `ready` and then delivers nothing — the measured stall,
 * made deterministic. It records what it was asked to watch so the re-arm half
 * of the fix can be asserted directly rather than inferred.
 */
class StalledWatcher extends EventEmitter {
  readonly added: string[] = [];
  closed = false;

  constructor(roots: string[]) {
    super();
    this.added.push(...roots);
  }

  add(paths: string | readonly string[]): this {
    this.added.push(...(typeof paths === 'string' ? [paths] : paths));
    return this;
  }

  getWatched(): Record<string, string[]> {
    return {};
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

const watchers: StalledWatcher[] = [];

vi.mock('chokidar', () => ({
  watch: (roots: string | string[]) => {
    const watcher = new StalledWatcher(
      typeof roots === 'string' ? [roots] : roots,
    );
    watchers.push(watcher);
    // chokidar reports `ready` once its own scan completes; the stream behind
    // it is not necessarily live yet. That is the whole defect.
    setTimeout(() => watcher.emit('ready'), 0);
    return watcher;
  },
}));

const { ConfigLoader } = await import('../config-loader.js');

// The last reconciliation pass lands 15.75s after `ready`; every assertion here
// only needs the first pass or two, but the budget must clear a loaded machine.
const RECONCILE_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 30_000;
// Comfortably past the first two passes (0.25s and 0.75s), used to prove a
// *negative* — that nothing extra was emitted.
const SETTLE_MS = 1_500;

let home: string;
let loader: InstanceType<typeof ConfigLoader> | undefined;

function makeHome(): string {
  home = mkdtempSync(join(tmpdir(), 'config-reconcile-spec-'));
  for (const dir of ['config', 'agents', 'integrations']) {
    mkdirSync(join(home, dir), { recursive: true });
  }
  return home;
}

function startLoader(): {
  events: Array<[string, string]>;
  watcher: StalledWatcher;
} {
  loader = new ConfigLoader({ projectHomeDir: home, watchFiles: true });
  const events: Array<[string, string]> = [];
  for (const event of ['add', 'change', 'remove'] as const) {
    loader.on(event, (path) => events.push([event, path as string]));
  }
  const watcher = watchers.at(-1);
  if (!watcher) throw new Error('the loader did not create a watcher');
  return { events, watcher };
}

beforeEach(() => {
  watchers.length = 0;
  makeHome();
});

afterEach(async () => {
  await loader?.dispose();
  // `dispose()` returns before the watcher close settles (archive#956). This suite
  // removes the watched tree next, so it waits for the close it started.
  await loader?.whenWatcherClosed();
  loader = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('config watcher reconciliation', () => {
  it(
    'reports an agent directory the watcher never delivered',
    async () => {
      const { events } = startLoader();

      // Created after the watcher exists — exactly the window where the
      // notification is lost. The watcher under test never delivers it.
      const agentDir = join(home, 'agents', 'writer');
      const agentConfig = join(agentDir, 'agent.json');
      mkdirSync(agentDir);
      writeFileSync(agentConfig, JSON.stringify({ version: 1 }));

      await vi.waitFor(
        () => expect(events).toContainEqual(['add', agentConfig]),
        { timeout: RECONCILE_TIMEOUT_MS, interval: 50 },
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports an integration directory the watcher never delivered',
    async () => {
      const { events } = startLoader();

      const integrationDir = join(home, 'integrations', 'slack');
      const integrationConfig = join(integrationDir, 'integration.json');
      mkdirSync(integrationDir);
      writeFileSync(integrationConfig, JSON.stringify({ id: 'slack' }));

      await vi.waitFor(
        () => expect(events).toContainEqual(['add', integrationConfig]),
        { timeout: RECONCILE_TIMEOUT_MS, interval: 50 },
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    're-arms the watcher on a recovered directory so later edits are seen',
    async () => {
      const { watcher } = startLoader();

      const agentDir = join(home, 'agents', 'writer');
      mkdirSync(agentDir);
      writeFileSync(join(agentDir, 'agent.json'), '{}');

      // Recovering the file is not enough: unless chokidar is told the
      // directory exists, every later edit inside it is silent too.
      await vi.waitFor(() => expect(watcher.added).toContain(agentDir), {
        timeout: RECONCILE_TIMEOUT_MS,
        interval: 50,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'announces a recovered file exactly once, however many passes run',
    async () => {
      const { events } = startLoader();

      const agentConfig = join(home, 'agents', 'writer', 'agent.json');
      mkdirSync(join(home, 'agents', 'writer'));
      writeFileSync(agentConfig, '{}');

      await vi.waitFor(
        () => expect(events).toContainEqual(['add', agentConfig]),
        { timeout: RECONCILE_TIMEOUT_MS, interval: 50 },
      );
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

      expect(events.filter(([, path]) => path === agentConfig)).toEqual([
        ['add', agentConfig],
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'does not re-announce a file the watcher already delivered',
    async () => {
      const { events, watcher } = startLoader();

      const agentConfig = join(home, 'agents', 'writer', 'agent.json');
      mkdirSync(join(home, 'agents', 'writer'));
      writeFileSync(agentConfig, '{}');
      // The live path wins the race this time; reconciliation must stay quiet.
      watcher.emit('add', agentConfig);

      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

      expect(events.filter(([, path]) => path === agentConfig)).toEqual([
        ['add', agentConfig],
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stays silent about files that already existed when watching began',
    async () => {
      // `ignoreInitial: true` deliberately suppresses these. Reconciliation
      // must inherit that contract, not undo it by announcing the whole tree
      // on startup.
      mkdirSync(join(home, 'agents', 'existing'));
      writeFileSync(join(home, 'agents', 'existing', 'agent.json'), '{}');
      writeFileSync(join(home, 'config', 'app.json'), '{}');

      const { events } = startLoader();
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

      expect(events).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports a deletion the watcher never delivered',
    async () => {
      const agentDir = join(home, 'agents', 'writer');
      const agentConfig = join(agentDir, 'agent.json');
      mkdirSync(agentDir);
      writeFileSync(agentConfig, '{}');

      const { events } = startLoader();
      rmSync(agentDir, { recursive: true, force: true });

      await vi.waitFor(
        () => expect(events).toContainEqual(['remove', agentConfig]),
        { timeout: RECONCILE_TIMEOUT_MS, interval: 50 },
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ignores paths outside the watched pattern set',
    async () => {
      const { events } = startLoader();

      // Right directories, wrong shapes: the reconciliation must apply the
      // same predicate the live handlers do, or it becomes a second, wider
      // load path.
      mkdirSync(join(home, 'agents', 'writer', 'nested'), { recursive: true });
      writeFileSync(join(home, 'agents', 'writer', 'notes.json'), '{}');
      writeFileSync(
        join(home, 'agents', 'writer', 'nested', 'agent.json'),
        '{}',
      );
      writeFileSync(join(home, 'config', 'app.yaml'), 'x: 1');
      writeFileSync(join(home, 'integrations', 'slack.json'), '{}');

      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

      expect(events).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
