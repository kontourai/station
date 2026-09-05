import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { EventStore } from '../../../services/orchestration/event-store.js';
import {
  createPluginActivationSession,
  deferPluginActivationNotification,
  deliverPluginActivationNotifications,
  type PluginActivationComposition,
  pluginActivationCompositionPermit,
  registerPluginActivation,
} from '../../../services/plugins/plugin-activation-composition.js';
import { StationRuntime } from '../station-runtime.js';

// Real runtime mutation/barrier and journal; the model/Agent rebuild is the
// controlled asynchronous seam. This does not claim a full provider journey.
test.each(['applied', 'failed', 'deadline'] as const)(
  'runtime-owned plugin activation publishes readiness only after applied composition: %s',
  async (outcome) => {
    const root = mkdtempSync(
      join(tmpdir(), 'station-runtime-plugin-activation-'),
    );
    const store = new EventStore(join(root, 'events.sqlite'));
    const runtime = Object.create(StationRuntime.prototype) as any;
    runtime.agentConfigurationRevision = 0;
    runtime.agentConfigurationMutationQueue = Promise.resolve();
    runtime.agentConfigurationPersistenceQueue = Promise.resolve();
    runtime.agentConfigurationMutationsClosed = false;
    runtime.agentConfigurationActivationDeadlineMs = 30;
    runtime.agentMetadataMap = new Map();
    runtime.timers = [];
    runtime.logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    runtime.scheduleAgentConfigurationReconciliation = vi.fn();
    const journal = store.createPackageMcpAdmissionJournal();
    const digest = `sha256:${'a'.repeat(64)}`;
    const origin = 'b'.repeat(64);
    const record = journal.recordInstallation({
      pluginId: 'fixture',
      contentDigest: digest,
      origin,
      previous: null,
      activationPlan: {
        version: 1,
        artifactDigest: digest,
        descriptorDigest: digest,
        sourceDigest: digest,
        origin,
        consent: {
          kind: 'no-operator-decision',
          caller: 'runtime-owner-fixture',
        },
        previous: null,
        agents: [],
        ownedDependencies: [],
      },
    });
    if (record.state !== 'recorded') throw new Error('Fixture record refused');
    const session = createPluginActivationSession();
    const permit = registerPluginActivation(
      session,
      journal,
      record.installation,
      async () => {},
    );
    const observations: Array<{ ready: boolean; revision: number }> = [];
    const notify = vi.fn(() => {
      observations.push({
        ready: journal.admissionOpen(record.installation),
        revision: runtime.agentConfigurationRevision % 2,
      });
      throw new Error('Injected observer failure');
    });
    deferPluginActivationNotification(session, notify);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let composition: PluginActivationComposition | undefined;
    runtime.reloadConfigurationFromDisk = vi.fn(
      async (capability: PluginActivationComposition) => {
        composition = capability;
        expect(
          pluginActivationCompositionPermit(capability, journal, 'fixture'),
        ).toBe(permit);
        expect(journal.admissionOpen(record.installation)).toBe(false);
        if (outcome === 'failed') throw new Error('Injected rebuild failure');
        await blocked;
      },
    );
    let receipt: { status: string } | undefined;
    try {
      const pending = runtime.applyAgentConfigurationMutation(
        async (begin: () => void, activation: typeof receipt) => {
          receipt = activation;
          begin();
          return { persisted: true };
        },
        { pluginActivation: session },
      );
      await vi.waitFor(() => expect(composition).toBeDefined(), {
        interval: 1,
      });
      if (outcome === 'applied') {
        expect(journal.admissionOpen(record.installation)).toBe(false);
        expect(runtime.agentConfigurationRevision % 2).toBe(1);
        expect(notify).not.toHaveBeenCalled();
        release();
      }
      expect(await pending).toEqual({ persisted: true });
      expect(receipt?.status).toBe(
        outcome === 'applied' ? 'applied' : 'pending',
      );
      expect(journal.admissionOpen(record.installation)).toBe(
        outcome === 'applied',
      );
      expect(
        pluginActivationCompositionPermit(composition, journal, 'fixture'),
      ).toBeUndefined();
      expect(notify).toHaveBeenCalledTimes(outcome === 'applied' ? 1 : 0);
      expect(observations).toEqual(
        outcome === 'applied' ? [{ ready: true, revision: 0 }] : [],
      );
      deliverPluginActivationNotifications(session, runtime.logger.warn);
      expect(notify).toHaveBeenCalledTimes(outcome === 'applied' ? 1 : 0);
      if (outcome === 'applied')
        expect(runtime.logger.warn).toHaveBeenCalledWith(
          'Plugin readiness notification failed',
          { error: expect.any(Error) },
        );
      // A timed-out pass resuming later cannot publish readiness.
      release();
      await Promise.resolve();
      await Promise.resolve();
      if (outcome !== 'applied')
        expect(journal.admissionOpen(record.installation)).toBe(false);
    } finally {
      release();
      for (const timer of runtime.timers) clearTimeout(timer);
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
