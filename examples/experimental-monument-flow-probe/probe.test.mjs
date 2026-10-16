import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFakeProcessTable,
  openCrashPointStore,
  registerKernelConformance,
} from '@kontourai/monument/testing';
import { describe, expect, it } from 'vitest';
import { ContinuationProbe, openProbeStorage } from './adapter.mjs';

// This exact open path also backs the consumer scenarios below. There is no
// second storage implementation here: conformance qualifies its SQLite reuse.
const harness = {
  name: 'parked Flow continuation probe / public SQLite adapter',
  async createLocation() {
    const directory = mkdtempSync(join(tmpdir(), 'flow-monument-probe-'));
    return {
      async open(options = {}) {
        return openProbeStorage(join(directory, 'probe.sqlite'), options);
      },
      async dispose() {
        rmSync(directory, { recursive: true, force: true });
      },
    };
  },
};
registerKernelConformance({ describe, it }, harness);

async function scenario(body) {
  const location = await harness.createLocation();
  const store = await openCrashPointStore(location);
  const processes = createFakeProcessTable();
  const owner = processes.spawn();
  const context = { liveness: processes.liveness };
  const probe = () =>
    new ContinuationProbe(store.storage, context, owner, processes.probe);
  try {
    await body({ store, processes, owner, probe, context });
  } finally {
    await store.dispose();
    await location.dispose();
  }
}
const at = (second) => `2026-10-15T00:00:0${second}.000Z`;
const capture = {
  schema_version: '1.0',
  turn_id: 'mission:1',
  iteration: 1,
  request: {
    schema_version: '1.0',
    run_id: 'mission',
    definition_id: 'definition',
    current_step: 'build',
    iteration: 1,
    max_turns: 2,
    next_action: null,
  },
  result: { status: 'wait', barrier: { kind: 'deadline', at: at(9) } },
  progress: null,
  captured_at: at(3),
};

describe('bounded continuation consumer', () => {
  it('does not invoke after the durable invoking fence fails, and a prepared restart can proceed', async () => {
    await scenario(async ({ store, processes, owner, probe, context }) => {
      const boundary = await probe().prepare('mission', 1, at(1));
      let effects = 0;
      store.failNextCommit();
      await expect(
        probe().invoke(boundary, at(2), () => {
          effects++;
        }),
      ).rejects.toThrow();
      expect(effects).toBe(0);
      await store.crash();
      processes.kill(owner);
      await store.reopen();
      expect(await probe().recover(at(3))).toEqual({
        kind: 'reconciled',
        interrupted: [],
      });
      const next = new ContinuationProbe(
        store.storage,
        context,
        processes.spawn(),
        processes.probe,
      );
      await next.prepare('mission', 1, at(4));
      await next.invoke(boundary, at(5), () => {
        effects++;
      });
      expect(effects).toBe(1);
    });
  });

  it('holds a started turn after owner death without invoking the retry', async () => {
    await scenario(async ({ store, processes, owner, probe, context }) => {
      const boundary = await probe().prepare('mission', 1, at(1));
      let effects = 0;
      await probe().invoke(boundary, at(2), () => {
        effects++;
      });
      await store.crash();
      processes.kill(owner);
      await store.reopen();
      const recovered = await probe().recover(at(3));
      expect(recovered.kind).toBe('reconciled');
      expect(recovered.interrupted.map((row) => row.state)).toEqual([
        'indeterminate',
      ]);
      const next = new ContinuationProbe(
        store.storage,
        context,
        processes.spawn(),
        processes.probe,
      );
      await expect(next.prepare('mission', 2, at(4))).rejects.toThrow(
        'prepare: busy',
      );
      await expect(
        next.invoke(boundary, at(5), () => {
          effects++;
        }),
      ).rejects.toThrow('invoke: stale');
      expect(effects).toBe(1);
    });
  });

  it('replays an identical accepted capture after reopen and refuses a conflicting result', async () => {
    await scenario(async ({ store, probe }) => {
      const boundary = await probe().prepare('mission', 1, at(1));
      await probe().invoke(boundary, at(2), () => capture.result);
      expect(await probe().capture(capture, at(3))).toEqual(capture);
      await store.crash();
      await store.reopen();
      expect(await probe().capture(capture, at(4))).toEqual(capture);
      await expect(
        probe().capture({ ...capture, result: { status: 'completed' } }, at(5)),
      ).rejects.toThrow('capture: conflict');
    });
  });

  it('exposes the capture-to-boundary atomicity gap instead of claiming measured recovery', async () => {
    await scenario(async ({ store, processes, owner, probe }) => {
      const boundary = await probe().prepare('mission', 1, at(1));
      await probe().invoke(boundary, at(2), () => capture.result);
      // A peer retains the original boundary ownership. The capture commits,
      // then the stale consumer cannot advance that boundary.
      const stale = new ContinuationProbe(
        store.storage,
        { liveness: processes.liveness },
        processes.spawn(),
        processes.probe,
      );
      await expect(stale.capture(capture, at(3))).rejects.toThrow(
        'accept: stale',
      );
      await store.crash();
      processes.kill(owner);
      await store.reopen();
      expect(await probe().capture(capture, at(4))).toEqual(capture);
      const recovered = await probe().recover(at(5));
      expect(recovered.interrupted.map((row) => row.state)).toEqual([
        'indeterminate',
      ]);
    });
  });
});
