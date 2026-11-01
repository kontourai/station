/**
 * Dogfood and e2e run Station under the process supervisor (#4135): the
 * instance record names the supervisor, which holds the server ports beside
 * the core generation it forked. These pin the rules that let health, the
 * reconciler's exit classification, and the e2e runner accept that without
 * accepting anything else.
 */
import { describe, expect, it, vi } from 'vitest';
import { daemonIsLive, discoverE2EDaemon } from '../run-e2e-suite.mjs';
import { assertListenerOwnership } from '../station-dogfood-health.mjs';
import { supervisedInstanceEvents } from '../station-dogfood-reconcile.mjs';

const SUPERVISOR = 4100;
const CORE = 4200;
const UI = 4300;
const record = (supervised: boolean) => ({
  serverPort: 41000,
  serverPid: SUPERVISOR,
  uiPort: 42000,
  uiPid: UI,
  ...(supervised ? { supervised: true } : {}),
});
const observed = (serverOwners: number[]) => () => ({
  owners: new Map([
    [41000, new Set(serverOwners)],
    [41001, new Set(serverOwners)],
    [41002, new Set(serverOwners)],
    [41003, new Set(serverOwners)],
    [42000, new Set([UI])],
  ]),
  source: 'lsof',
  reason: undefined,
  authoritative: true,
});
const deadline = () => Date.now() + 5_000;

describe('dogfood health listener ownership under the supervisor', () => {
  it('accepts the recorded supervisor holding the server ports with its own core', () => {
    const parentOf = vi.fn((pid: number) => (pid === CORE ? SUPERVISOR : null));
    expect(() =>
      assertListenerOwnership(
        record(true),
        deadline(),
        observed([SUPERVISOR, CORE]),
        parentOf,
      ),
    ).not.toThrow();
    expect(parentOf).toHaveBeenCalledWith(CORE);
  });

  it('refuses a co-owner that is not the supervisor’s child, or whose parent is unknown', () => {
    for (const parent of [9999, null]) {
      expect(() =>
        assertListenerOwnership(
          record(true),
          deadline(),
          observed([SUPERVISOR, CORE]),
          () => parent,
        ),
      ).toThrow('api listener ownership mismatch');
    }
    // A third owner is never one generation.
    expect(() =>
      assertListenerOwnership(
        record(true),
        deadline(),
        observed([SUPERVISOR, CORE, 4201]),
        () => SUPERVISOR,
      ),
    ).toThrow('api listener ownership mismatch');
    // Without the supervisor, the core alone does not own the instance.
    expect(() =>
      assertListenerOwnership(
        record(true),
        deadline(),
        observed([CORE]),
        () => SUPERVISOR,
      ),
    ).toThrow('api listener ownership mismatch');
  });

  it('keeps a direct start to a single listener', () => {
    expect(() =>
      assertListenerOwnership(
        record(false),
        deadline(),
        observed([SUPERVISOR, CORE]),
        () => SUPERVISOR,
      ),
    ).toThrow('api listener ownership mismatch');
    expect(() =>
      assertListenerOwnership(
        record(false),
        deadline(),
        observed([SUPERVISOR]),
        () => null,
      ),
    ).not.toThrow();
  });
});

describe('dogfood prior-exit events of a supervised instance', () => {
  it('keeps only the newest generation and the CLI’s own events', () => {
    const cli = { type: 'started', pid: SUPERVISOR };
    const drained = {
      type: 'process_exit',
      exitCode: 0,
      supervisor: { pid: SUPERVISOR, generation: 1 },
    };
    const started2 = {
      type: 'started',
      supervisor: { pid: SUPERVISOR, generation: 2 },
    };
    expect(supervisedInstanceEvents([cli, drained, started2])).toEqual([
      cli,
      started2,
    ]);
    // A direct start's journal is untouched.
    const direct = [cli, { type: 'process_exit', exitCode: 1, pid: 1 }];
    expect(supervisedInstanceEvents(direct)).toEqual(direct);
  });
});

describe('e2e daemon identity under the supervisor', () => {
  const registry = {
    serverPid: SUPERVISOR,
    uiPid: UI,
    bootId: 'boot-1',
    serverFingerprint: { pid: SUPERVISOR, startToken: 's' },
    uiFingerprint: { pid: UI, startToken: 'u' },
    supervised: true,
  };
  const identities = new Map([
    [SUPERVISOR, { pid: SUPERVISOR, processStart: 'a', pgid: SUPERVISOR }],
    [UI, { pid: UI, processStart: 'b', pgid: UI }],
    [CORE, { pid: CORE, processStart: 'c', pgid: CORE }],
  ]);
  const processIdentityFn = (pid: number) => identities.get(pid) ?? null;
  const fetchImpl = async () =>
    new Response(JSON.stringify({ instanceId: 'e2e', bootId: 'boot-1' }));
  const discover = (status: unknown) => {
    // The JS signature's inferred type omits the options that have no
    // default (root, instance, ports, authority), so pass a named object.
    const options = {
      root: '/checkout',
      instance: 'e2e',
      serverPort: 1,
      uiPort: 2,
      bootstrapAuthority: { registry, operatorCredential: 'a'.repeat(43) },
      fetchImpl,
      processIdentityFn,
      readSupervisorStatus: () => status,
    };
    return discoverE2EDaemon(options);
  };

  it.skipIf(process.platform === 'win32')(
    'records the serving generation, and holds the lease until it is gone',
    async () => {
      const daemon = await discover({
        supervisor: { pid: SUPERVISOR, instance: 'e2e' },
        state: 'serving',
        active: { pid: CORE },
      });
      expect(daemon.generation).toMatchObject({ pid: CORE });
      // The supervisor and UI are gone but the generation still runs.
      const generationOnly = (pid: number) =>
        pid === CORE ? (identities.get(CORE) ?? null) : null;
      expect(daemonIsLive(daemon, generationOnly, { platform: 'darwin' })).toBe(
        true,
      );
      expect(daemonIsLive(daemon, () => null, { platform: 'darwin' })).toBe(
        false,
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a supervisor that is not the one the registry names',
    async () => {
      await expect(
        discover({
          supervisor: { pid: 9999, instance: 'e2e' },
          state: 'serving',
          active: { pid: CORE },
        }),
      ).rejects.toThrow(
        'Station supervisor identity differs from the registry',
      );
      await expect(
        discover({
          supervisor: { pid: SUPERVISOR, instance: 'e2e' },
          state: 'handoff',
          active: { pid: CORE },
        }),
      ).rejects.toThrow(
        'Station supervisor identity differs from the registry',
      );
    },
  );
});
