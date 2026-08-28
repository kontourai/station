// @vitest-environment node

/**
 * Launchability revisions for `config/app.json`, against a watch layer whose
 * delivery the test controls rather than hopes for.
 *
 * `ConfigLoader` has two independent ways to notice that `config/app.json`
 * changed underneath it: the chokidar watcher's `change`/`add`/`unlink` events,
 * and a 250ms poller that compares the file's `stat` signature. Both end in
 * `LaunchabilityRevision.commit()`, and the whole difficulty is that they must
 * agree — one change is one revision no matter which path saw it first, and an
 * internal write must not be re-counted when the watcher reports it back.
 *
 * These assertions used to live in `config-loader-app.test.ts` against a real
 * chokidar watcher, and that shape had two problems.
 *
 * The first is cost. A real watcher means a real `FSWatcher.close()`, which is
 * a *synchronous* 0.5-17s block of the JS thread (archive#956) that the suite has to
 * await before it can delete the watched tree. Two such tests were enough to
 * push the file to a 46s timeout in the serialized lane.
 *
 * The second is worse: the coverage was not there to begin with. Because the
 * poller alone recovers every one of these cases, the tests passed whether or
 * not the watcher delivered anything — verified directly by running the old
 * file against a watch layer that arms and never delivers (archive#970), where all 22
 * tests still passed. "The watcher observed an internal write" was an
 * unenforced precondition, so the deduplication it claimed to prove was never
 * actually exercised.
 *
 * Driving the watcher explicitly fixes both. The loader, the poller, the
 * fingerprint/signature bookkeeping, the internal-mutation barrier and the
 * revision counter are all real production code; only the source of the
 * notification is under test control, which is the one thing the OS refuses to
 * make deterministic.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A watcher that arms and then delivers exactly what the test tells it to.
 *
 * `ready` is emitted the way chokidar emits it — once its own directory scan
 * would have finished — because that is the signal `ConfigLoader` starts its
 * reconciliation backoff from.
 */
class ScriptedWatcher extends EventEmitter {
  readonly added: string[] = [];
  closeCalls = 0;

  add(paths: string | readonly string[]): this {
    this.added.push(...(typeof paths === 'string' ? [paths] : paths));
    return this;
  }

  getWatched(): Record<string, string[]> {
    return {};
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

const watchers: ScriptedWatcher[] = [];

vi.mock('chokidar', () => ({
  watch: (roots: string | string[]) => {
    const watcher = new ScriptedWatcher();
    watcher.add(typeof roots === 'string' ? [roots] : roots);
    watchers.push(watcher);
    setTimeout(() => watcher.emit('ready'), 0);
    return watcher;
  },
}));

const { ConfigLoader } = await import('../config-loader.js');

/** Generous against a loaded machine; every case here needs one 250ms tick. */
const REVISION_TIMEOUT_MS = 10_000;
/** Three poller ticks. Used to prove a *negative* — that nothing more fired. */
const SETTLE_MS = 800;

let tempDir: string;
let loader: InstanceType<typeof ConfigLoader> | undefined;
let appPath: string;

function startLoader(): {
  revisions: number[];
  events: Array<[string, string]>;
  watcher: ScriptedWatcher;
} {
  loader = new ConfigLoader({ projectHomeDir: tempDir, watchFiles: true });
  const revisions: number[] = [];
  loader.onLaunchabilityChange((revision) => revisions.push(revision));
  const events: Array<[string, string]> = [];
  for (const event of ['add', 'change', 'remove'] as const) {
    loader.on(event, (path) => events.push([event, path as string]));
  }
  const watcher = watchers.at(-1);
  if (!watcher) throw new Error('the loader did not create a watcher');
  return { revisions, events, watcher };
}

const ready = (watcher: ScriptedWatcher): Promise<void> =>
  new Promise((resolve) => watcher.once('ready', () => resolve()));

beforeEach(() => {
  watchers.length = 0;
  tempDir = mkdtempSync(join(tmpdir(), 'station-app-config-watch-'));
  mkdirSync(join(tempDir, 'config'), { recursive: true });
  appPath = join(tempDir, 'config', 'app.json');
});

afterEach(async () => {
  await loader?.dispose();
  await loader?.whenWatcherClosed();
  loader = undefined;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('app config launchability', () => {
  it('publishes revisions for external add, change and remove with no watcher event at all', async () => {
    // The archive#970 host, exactly: the watcher is armed and stays silent forever.
    // `config/app.json` is the one watched file with a second line of defence,
    // and this is the test that says so out loud.
    const { revisions, watcher } = startLoader();
    await ready(watcher);

    writeFileSync(appPath, '{"defaultModel":"model-a"}', 'utf8');
    await vi.waitFor(() => expect(revisions).toEqual([1]), {
      timeout: REVISION_TIMEOUT_MS,
    });

    rmSync(appPath);
    await vi.waitFor(() => expect(revisions).toEqual([1, 2]), {
      timeout: REVISION_TIMEOUT_MS,
    });

    writeFileSync(appPath, '{"defaultModel":"model-b"}', 'utf8');
    await vi.waitFor(() => expect(revisions).toEqual([1, 2, 3]), {
      timeout: REVISION_TIMEOUT_MS,
    });
  });

  it('recovers a content change that the reconciliation cannot see', async () => {
    // The case above has two rescuers, because appearing and disappearing are
    // both visible to the archive#952 reconciliation, which diffs *path existence*.
    // Seeding the file before the loader starts puts it in `knownConfigPaths`,
    // so reconciliation is permanently silent about it and the 250ms
    // fingerprint poller is the only mechanism left. This is the assertion that
    // says content changes to `config/app.json` survive a dead watch layer —
    // and, by contrast, why agent and integration files do not.
    writeFileSync(appPath, '{"defaultModel":"model-a"}', 'utf8');
    const { revisions, events, watcher } = startLoader();
    await ready(watcher);

    writeFileSync(appPath, '{"defaultModel":"model-b"}', 'utf8');

    await vi.waitFor(() => expect(revisions).toEqual([1]), {
      timeout: REVISION_TIMEOUT_MS,
    });
    // No config file event was forwarded to a listener, so nothing here came
    // from a notification or from a reconciliation pass.
    expect(events).toEqual([]);
  });

  it('publishes exactly one revision when the watcher does deliver the external change', async () => {
    const { revisions, events, watcher } = startLoader();
    await ready(watcher);

    writeFileSync(appPath, '{"defaultModel":"model-a"}', 'utf8');
    watcher.emit('add', appPath);

    await vi.waitFor(() => expect(revisions).toEqual([1]), {
      timeout: REVISION_TIMEOUT_MS,
    });
    // The poller must now find nothing to do; two observers of one change are
    // still one revision.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    expect(revisions).toEqual([1]);
    expect(events).toEqual([['add', appPath]]);
  });

  it('publishes one revision when the watcher observes an internal app write', async () => {
    const { revisions, watcher } = startLoader();
    await ready(watcher);

    await loader!.updateAppConfig({ defaultModel: 'model-a' });
    // The event the watcher would report for Station's own write. Before this
    // was driven explicitly the assertion held vacuously, because on a slow or
    // dead watch layer no such event ever arrived inside the test's window.
    watcher.emit('change', appPath);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    expect(revisions).toEqual([1]);
  });
});
