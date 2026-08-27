/**
 * Shutdown must not pay for the config watcher close (#956).
 *
 * `StationRuntime.shutdown()` is the app-quit path, and `configLoader.dispose()`
 * was the whole of its latency. Measured here with every other shutdown step
 * under 20ms: min 566ms / p50 1403ms / max 5184ms idle over 10 rounds, and
 * min 527ms / p50 ~10.2s / max 17031ms over 40 rounds under 8-way load.
 *
 * The important half is *how* it costs that. `FSWatcher.close()` looks async,
 * but chokidar runs every closer inline and hands back an already-settled
 * promise, so the entire cost is a synchronous block of the JS thread in
 * `uv_fs_event_stop` — splitting the call from its promise measured
 * `sync=1045ms async=0.0ms`, `sync=5932ms async=0.0ms`, and so on for 8/8
 * rounds. Nothing can overlap or time-box a synchronous block; the only fix is
 * not to call it on the quit path. `dispose()` therefore defers the close to a
 * later turn of the event loop, where `process.exit()` beats it in production
 * and `whenWatcherClosed()` waits for it in tests.
 *
 * These tests do not time real FSEvents — a stopwatch assertion against a real
 * teardown fails exactly when the machine is busy, which is when the defect is
 * worst. They substitute watchers that model the two properties that matter (a
 * synchronous block; a close that never settles) and assert the deterministic
 * consequence: `dispose()` resolves without the close having been called at
 * all. Everything else under test is production code.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** How long `BlockingWatcher.close()` occupies the thread, chokidar-style. */
const SYNC_BLOCK_MS = 2_000;

function blockThread(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A watcher whose close blocks the thread synchronously and returns a settled
 * promise — chokidar's actual shape, with the OS cost made deterministic.
 */
class BlockingWatcher extends EventEmitter {
  closeCalls = 0;

  add(): this {
    return this;
  }

  getWatched(): Record<string, string[]> {
    return {};
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    blockThread(SYNC_BLOCK_MS);
    return Promise.resolve();
  }
}

/** A watcher whose close is held open until the test lets it finish. */
class HeldWatcher extends EventEmitter {
  closeCalls = 0;
  private releaseClose?: () => void;
  private closeFailure?: Error;
  private released = false;

  add(): this {
    return this;
  }

  getWatched(): Record<string, string[]> {
    return {};
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    return new Promise<void>((resolve, reject) => {
      this.releaseClose = () => {
        if (this.closeFailure) reject(this.closeFailure);
        else resolve();
      };
      // The close is now deferred (#956), so a release can be requested before
      // `close()` is ever called. Honour it rather than hanging.
      if (this.released) this.releaseClose();
    });
  }

  /** Let `close()` settle — now or on arrival — the way the OS eventually would. */
  finishClose(failure?: Error): void {
    this.closeFailure = failure;
    this.released = true;
    this.releaseClose?.();
  }
}

type FakeWatcher = BlockingWatcher | HeldWatcher;

const watchers: FakeWatcher[] = [];
let makeWatcher: () => FakeWatcher = () => new HeldWatcher();
let emitReadyImmediately = true;

vi.mock('chokidar', () => ({
  watch: () => {
    const watcher = makeWatcher();
    watchers.push(watcher);
    if (emitReadyImmediately) setTimeout(() => watcher.emit('ready'), 0);
    return watcher;
  },
}));

const { ConfigLoader } = await import('../config-loader.js');

/** Past the first two reconciliation passes (0.25s, 0.75s), used for negatives. */
const SETTLE_MS = 1_500;

let home: string;
let loader: InstanceType<typeof ConfigLoader> | undefined;

function makeHome(): string {
  home = mkdtempSync(join(tmpdir(), 'config-dispose-spec-'));
  for (const dir of ['config', 'agents', 'integrations']) {
    mkdirSync(join(home, dir), { recursive: true });
  }
  return home;
}

function startLoader<T extends FakeWatcher>(): {
  events: Array<[string, string]>;
  watcher: T;
} {
  loader = new ConfigLoader({ projectHomeDir: home, watchFiles: true });
  const events: Array<[string, string]> = [];
  for (const event of ['add', 'change', 'remove'] as const) {
    loader.on(event, (path) => events.push([event, path as string]));
  }
  const watcher = watchers.at(-1);
  if (!watcher) throw new Error('the loader did not create a watcher');
  return { events, watcher: watcher as T };
}

/** Resolves to `true` only if `promise` settles inside `timeoutMs`. */
async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([promise.then(() => true), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

beforeEach(() => {
  watchers.length = 0;
  makeWatcher = () => new HeldWatcher();
  emitReadyImmediately = true;
  makeHome();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const watcher of watchers) {
    if (watcher instanceof HeldWatcher) watcher.finishClose();
  }
  await loader?.whenWatcherClosed().catch(() => undefined);
  loader = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
}, 30_000);

describe('ConfigLoader dispose', () => {
  it('does not pay the synchronous watcher close on the disposing turn', async () => {
    makeWatcher = () => new BlockingWatcher();
    const { watcher } = startLoader<BlockingWatcher>();

    const startedAt = performance.now();
    await loader!.dispose();
    const disposeMs = performance.now() - startedAt;

    // The deterministic half: the close has not even been *called* yet, so
    // dispose cannot have paid for it. Before #956 this was 1.
    expect(watcher.closeCalls).toBe(0);
    // The corroborating half, with a full 2s of headroom against a block
    // dispose would otherwise have absorbed in full.
    expect(disposeMs).toBeLessThan(SYNC_BLOCK_MS);

    // Deferred, not skipped: it still runs, one turn later.
    await loader!.whenWatcherClosed();
    expect(watcher.closeCalls).toBe(1);
  }, 30_000);

  it('exposes the residual close so callers can await a settled teardown', async () => {
    const { watcher } = startLoader<HeldWatcher>();

    await loader!.dispose();
    const closed = loader!.whenWatcherClosed();

    // Still open: `dispose()` resolving is not a claim that the OS handle is
    // gone, only that Station is no longer waiting on it.
    expect(await settlesWithin(closed, 100)).toBe(false);
    expect(watcher.closeCalls).toBe(1);

    watcher.finishClose();
    await expect(closed).resolves.toBeUndefined();
  });

  it('does not reject the residual close when the watcher close fails', async () => {
    const { watcher } = startLoader<HeldWatcher>();

    await loader!.dispose();
    watcher.finishClose(new Error('close blew up'));

    // There is nothing to fall back to at this point, so the failure is logged
    // rather than surfaced as an unhandled rejection on the quit path.
    await expect(loader!.whenWatcherClosed()).resolves.toBeUndefined();
  });

  it('is idempotent: a second dispose closes nothing twice', async () => {
    const { watcher } = startLoader<HeldWatcher>();

    const first = loader!.dispose();
    const second = loader!.dispose();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    await loader!.dispose();

    watcher.finishClose();
    await loader!.whenWatcherClosed();
    await expect(loader!.dispose()).resolves.toBeUndefined();
    expect(watcher.closeCalls).toBe(1);
  });

  it('stays silent about events delivered while the close is pending', async () => {
    const { events, watcher } = startLoader<HeldWatcher>();
    const agentConfig = join(home, 'agents', 'writer', 'agent.json');
    mkdirSync(join(home, 'agents', 'writer'));
    writeFileSync(agentConfig, '{}');

    await loader!.dispose();
    // A watcher that has not closed yet is still a live subscription; chokidar
    // can deliver during that window, and a disposed loader must not act on it.
    watcher.emit('add', agentConfig);
    watcher.emit('change', agentConfig);
    watcher.emit('unlink', agentConfig);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(events).toEqual([]);
  });

  it('cancels the pending post-ready reconciliation passes', async () => {
    // #958 schedules six reconciliation passes out to 15.75s after `ready`.
    // Disposing must stop that chain, not leave it firing into a torn-down
    // loader.
    const { events } = startLoader<HeldWatcher>();

    await loader!.dispose();
    // Exactly the change a live reconciliation pass would report.
    mkdirSync(join(home, 'agents', 'writer'));
    writeFileSync(join(home, 'agents', 'writer', 'agent.json'), '{}');
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    expect(events).toEqual([]);
  });

  it('leaves no timer behind, with the reconciliation chain mid-flight', async () => {
    // `setImmediate` stays real: the deferred close is deliberately scheduled,
    // not leaked, and faking it would count it as an outstanding timer.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    emitReadyImmediately = false;
    const { watcher } = startLoader<HeldWatcher>();

    // Arm both timer sources: the 250ms launchability poller runs from
    // construction, and `ready` starts the reconciliation backoff.
    watcher.emit('ready');
    await vi.advanceTimersByTimeAsync(300);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await loader!.dispose();

    expect(vi.getTimerCount()).toBe(0);
  });
});
