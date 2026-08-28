import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { ACPStatus } from '@kontourai/station-contracts/acp';
import { describe, expect, test, vi } from 'vitest';
import { getACPManagerStatus } from '../acp-manager-view.js';
import { ACPProbe } from '../acp-probe.js';
import type { ACPProcess } from '../acp-process.js';

function createProbe({
  available = false,
  lastProbeAt = 0,
  modes = [],
  configOptions = [],
  capabilities = {},
}: {
  available?: boolean;
  lastProbeAt?: number;
  modes?: Array<{ id: string; name?: string; description?: string }>;
  configOptions?: any[];
  capabilities?: { image?: boolean };
}) {
  return {
    lastProbeAt,
    getModes: () => modes,
    getConfigOptions: () => configOptions,
    getCapabilities: () => capabilities,
    isAvailable: () => available,
  };
}

describe('acp-manager-view helpers', () => {
  test('builds status for each connection', () => {
    const probes = new Map([
      [
        'kiro',
        createProbe({
          available: true,
          lastProbeAt: 123,
          modes: [{ id: 'dev' }],
          configOptions: [{ category: 'model', currentValue: 'claude-sonnet' }],
        }),
      ],
      [
        'claude',
        createProbe({
          available: false,
          lastProbeAt: 456,
          modes: [{ id: 'plan' }],
        }),
      ],
    ]);
    const configs = new Map([
      ['kiro', { id: 'kiro', name: 'Kiro', enabled: true }],
      ['claude', { id: 'claude', name: 'Claude', enabled: true }],
    ]);

    const status = getACPManagerStatus(probes as any, configs as any, 2);

    expect(status.activeSessions).toBe(2);
    expect(status.connections).toEqual([
      expect.objectContaining({
        id: 'kiro',
        status: ACPStatus.AVAILABLE,
        modes: ['dev'],
        currentModel: 'claude-sonnet',
      }),
      expect.objectContaining({
        id: 'claude',
        status: ACPStatus.UNAVAILABLE,
        modes: ['plan'],
        currentModel: null,
      }),
    ]);
  });

  describe('station#1549: dating the capability evidence', () => {
    function probeWithHandshake(overrides: {
      agentCapabilities?: unknown;
      observedAt?: number;
      lastProbeAt?: number;
    }) {
      return {
        lastProbeAt: overrides.lastProbeAt ?? 0,
        getModes: () => [],
        getConfigOptions: () => [],
        getCapabilities: () => ({}),
        getAgentCapabilities: () => overrides.agentCapabilities ?? null,
        getHandshakeObservedAt: () => overrides.observedAt ?? 0,
        isAvailable: () => true,
      };
    }

    test('emits handshakeObservedAt from the handshake instant, NOT from lastProbeAt', () => {
      // The two differ exactly where it matters: a probe that failed still
      // bumps `lastProbeAt` while deliberately retaining the previous
      // capability cache. Dating the evidence with `lastProbeAt` would
      // re-date an observation nothing re-observed.
      const probes = new Map([
        [
          'kiro',
          probeWithHandshake({
            agentCapabilities: { mcpCapabilities: { http: true } },
            observedAt: Date.parse('2026-08-01T10:00:00.000Z'),
            lastProbeAt: Date.parse('2026-08-02T10:00:00.000Z'),
          }),
        ],
      ]);
      const status = getACPManagerStatus(
        probes as any,
        new Map([['kiro', { id: 'kiro', name: 'Kiro', enabled: true }]]) as any,
        0,
      );
      expect(status.connections[0].handshakeObservedAt).toBe(
        '2026-08-01T10:00:00.000Z',
      );
    });

    test('no successful handshake ⇒ no timestamp — a date without an observation dates nothing', () => {
      const probes = new Map([
        ['bare', probeWithHandshake({ observedAt: 0, lastProbeAt: 999 })],
      ]);
      const status = getACPManagerStatus(
        probes as any,
        new Map([['bare', { id: 'bare', name: 'Bare', enabled: true }]]) as any,
        0,
      );
      expect(status.connections[0].capabilities).toBeUndefined();
      expect(status.connections[0].handshakeObservedAt).toBeUndefined();
    });

    test('a SUCCESSFUL handshake that carried no agentCapabilities is still dated — it is an observation whose answer is "advertised nothing"', () => {
      // Review finding. `agentCapabilities` is optional in the ACP SDK and the
      // client does not default it, so this is a real wire shape. Keying the
      // timestamp on capability presence would report a CLI Station has
      // connected to, handshaked with and created a session on as "not checked
      // yet" — permanently, since nothing about it can ever change.
      const probes = new Map([
        [
          'silent',
          probeWithHandshake({
            agentCapabilities: null,
            observedAt: Date.parse('2026-08-01T09:00:00.000Z'),
            lastProbeAt: Date.parse('2026-08-01T09:00:00.000Z'),
          }),
        ],
      ]);
      const status = getACPManagerStatus(
        probes as any,
        new Map([
          ['silent', { id: 'silent', name: 'Silent', enabled: true }],
        ]) as any,
        0,
      );
      expect(status.connections[0].capabilities).toBeUndefined();
      expect(status.connections[0].handshakeObservedAt).toBe(
        '2026-08-01T09:00:00.000Z',
      );
    });

    test('a probe implementation that predates the timestamp getter degrades to no timestamp, never to a fabricated one', () => {
      const probes = new Map([
        [
          'legacy',
          {
            lastProbeAt: 123,
            getModes: () => [],
            getConfigOptions: () => [],
            getCapabilities: () => ({}),
            getAgentCapabilities: () => ({ mcpCapabilities: { http: true } }),
            isAvailable: () => true,
          },
        ],
      ]);
      const status = getACPManagerStatus(
        probes as any,
        new Map([
          ['legacy', { id: 'legacy', name: 'Legacy', enabled: true }],
        ]) as any,
        0,
      );
      expect(status.connections[0].capabilities).toBeDefined();
      expect(status.connections[0].handshakeObservedAt).toBeUndefined();
    });
  });

  describe('station#3404: a first handshake still in flight is PROBING, not UNAVAILABLE', () => {
    function probeWithFlight(overrides: {
      inFlight: boolean;
      lastProbeAt?: number;
    }) {
      return {
        lastProbeAt: overrides.lastProbeAt ?? 0,
        getModes: () => [],
        getConfigOptions: () => [],
        getCapabilities: () => ({}),
        getHandshakeObservedAt: () => 0,
        isProbeInFlight: () => overrides.inFlight,
        isAvailable: () => false,
      };
    }

    test('never-handshaked + probe in flight (even after a cold timeout stamped lastProbeAt) ⇒ PROBING', () => {
      // The exact archive#3404 shape: the first (cold) probe timed out at the old
      // tight deadline, stamped lastProbeAt, and a re-probe is now in flight
      // while the slow engine is still starting. Old derivation read
      // UNAVAILABLE; the connection is being probed, not broken.
      const status = getACPManagerStatus(
        new Map([
          ['cold', probeWithFlight({ inFlight: true, lastProbeAt: 999 })],
        ]) as any,
        new Map([['cold', { id: 'cold', name: 'Cold', enabled: true }]]) as any,
        0,
      );
      expect(status.connections[0].status).toBe(ACPStatus.PROBING);
    });

    test('never-handshaked + NO probe in flight + lastProbeAt stamped ⇒ still UNAVAILABLE', () => {
      // The flip side: between probes, a connection whose only completed
      // probe failed is genuinely unavailable — PROBING must not smear over
      // the failure classification once the flight ends.
      const status = getACPManagerStatus(
        new Map([
          ['cold', probeWithFlight({ inFlight: false, lastProbeAt: 999 })],
        ]) as any,
        new Map([['cold', { id: 'cold', name: 'Cold', enabled: true }]]) as any,
        0,
      );
      expect(status.connections[0].status).toBe(ACPStatus.UNAVAILABLE);
    });

    test('an in-flight probe on a REAL previously-handshaked (now repeatedly failing) probe does NOT claim PROBING', async () => {
      // Driven through a real `ACPProbe` rather than a double that hardcodes
      // `getHandshakeObservedAt: () => 500`. That hardcode was the whole
      // reason this test passed: the probe used to reset
      // `lastHandshakeObservedAt` to 0 on a failure whose predecessor had
      // also failed, so a real probe in this exact state (handshaked, then
      // two failed sweeps, then a third in flight) returned 0 and the view
      // reported PROBING for a permanently broken engine — on every sweep,
      // for ~72s at a time, on the cold budget it also wrongly re-earned.
      let attempt = 0;
      const hang = new Promise<any>(() => {});
      const spawned: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
      const makeProc = (start: () => Promise<any>) => {
        const proc = {
          start: vi.fn(start),
          newSession: vi.fn(
            async () =>
              ({
                sessionId: 's',
                modes: { availableModes: [] },
                configOptions: [],
              }) as any,
          ),
          destroy: vi.fn(async () => {}),
          forceGroupKill: vi.fn(),
          survivesCleanup: () => false,
          releaseIfConfirmedGone: () => {},
        };
        spawned.push(proc);
        return proc as unknown as ACPProcess;
      };
      const probe = new ACPProbe(
        {
          id: 'warm',
          name: 'Warm',
          // A configured cwd keeps `probeCwd` on its synchronous branch — no
          // managed-workspace filesystem work in a view unit test.
          cwd: '/tmp/station-acp-3404-view',
          command: '/opt/engines/warm',
          enabled: true,
        } as ACPConnectionConfig,
        { warn: vi.fn() },
        '/tmp/project',
        () => {
          attempt += 1;
          if (attempt === 1) {
            return makeProc(async () => ({
              protocolVersion: 1,
              agentCapabilities: {},
            }));
          }
          if (attempt <= 3) {
            return makeProc(async () => {
              throw new Error('engine is no longer installed');
            });
          }
          return makeProc(() => hang);
        },
        1_000,
      );

      await expect(probe.probe('background')).resolves.toBe(true);
      await expect(probe.probe('background')).resolves.toBe(false);
      await expect(probe.probe('background')).resolves.toBe(false);
      expect(probe.getHandshakeObservedAt()).toBeGreaterThan(0);

      // A fourth probe is now in flight against the same broken engine.
      const inFlight = probe.probe('background');
      expect(probe.isProbeInFlight()).toBe(true);

      const status = getACPManagerStatus(
        new Map([['warm', probe]]) as any,
        new Map([['warm', { id: 'warm', name: 'Warm', enabled: true }]]) as any,
        0,
      );
      expect(status.connections[0].status).toBe(ACPStatus.UNAVAILABLE);
      // The handshake it really did complete is still dated, too.
      expect(status.connections[0].handshakeObservedAt).toBeDefined();

      await probe.dispose();
      await expect(inFlight).resolves.toBe(false);
    });
  });
});
