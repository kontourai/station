/**
 * Agent creates must not put runtime activation inside the serialized
 * configuration queues, and "activating" must be a state the runtime can
 * report per slug.
 *
 * Both properties come from the same incident. An earlier round switched
 * agent create to `activationMode: 'wait'` so `GET /agents/:slug/tools` would
 * answer 200 immediately instead of 409 "exists but is not active". That put
 * the activation inside the persistence AND access queues, where a
 * never-settling activation wedges every later configuration mutation and
 * shutdown. Bounding the response was tried and removed: the honest fix is
 * that create returns as soon as the write is durable, and the tools route
 * says "activating" until reconciliation makes the Agent live.
 *
 * These drive the real `applyAgentConfigurationMutation` on the same
 * `Object.create(StationRuntime.prototype)` harness
 * `station-runtime-configuration-revision.test.ts` uses.
 */

import { describe, expect, test, vi } from 'vitest';
import { StationRuntime } from '../station-runtime.js';

function harness() {
  const runtime = Object.create(StationRuntime.prototype) as any;
  runtime.agentConfigurationRevision = 0;
  runtime.agentConfigurationPersistenceRevision = 0;
  runtime.agentConfigurationMutationQueue = Promise.resolve();
  runtime.agentConfigurationPersistenceQueue = Promise.resolve();
  runtime.agentConfigurationMutationsClosed = false;
  runtime.loadedProviderLaunchabilityRevision = 0;
  runtime.loadedAppConfigLaunchabilityRevision = 0;
  runtime.configurationReconciliationAttempt = 0;
  runtime.configurationReconciliationScheduled = false;
  runtime.timers = [];
  // Deliberately NOT seeding the activation index or the awaiting set: the
  // runtime creates both on demand, so a partial harness — the pattern every
  // runtime suite here uses — must not have to know they exist.
  const events: string[] = [];
  runtime.logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  runtime.observeReconciliationChurn = vi.fn();
  runtime.runtimeConfigurationSourcesAreLoaded = () => false;
  // The runtime clears and repopulates this from disk on every full reload;
  // "the slug is in it afterwards" is how a pass proves it covered an agent.
  runtime.agentMetadataMap = new Map<string, unknown>();
  return { runtime, events };
}

/** A create-shaped deferred mutation, exactly as the agent routes issue it. */
function deferredCreate(runtime: any, slug: string) {
  return runtime.applyAgentConfigurationMutation(
    (beginMutation: () => void) => {
      beginMutation();
      return Promise.resolve({ slug });
    },
    {
      resolveAgentSlug: (result: { slug: string }) => result.slug,
      activationMode: 'defer',
    },
  );
}

describe('StationRuntime: a create returns durable, and reports activating', () => {
  test('(a) the create does not wait for activation, and the slug reads as activating until it is live', async () => {
    const { runtime, events } = harness();
    runtime.providerService = { getLaunchabilityRevision: () => 0 };
    runtime.configLoader = { getLaunchabilityRevision: () => 0 };
    runtime.appConfig = { region: 'us-east-1' };
    const context = runtime.buildRuntimeContext();

    let releaseReconciliation!: () => void;
    const reconciling = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    runtime.reloadAgentsFromDisk = vi.fn(async () => {
      events.push('reconcile-start');
      await reconciling;
      events.push('reconcile-end');
      runtime.runtimeConfigurationSourcesAreLoaded = () => true;
    });

    expect(context.isAgentConfigurationActivationPending('writer')).toBe(false);

    // The write returns the moment it is durable — no activation has run.
    await expect(deferredCreate(runtime, 'writer')).resolves.toEqual({
      slug: 'writer',
    });
    expect(events).not.toContain('reconcile-end');

    // …and from that instant the slug is "activating", which is what turns
    // the tools route's 409 into a 503 the client can retry.
    expect(context.isAgentConfigurationActivationPending('writer')).toBe(true);
    // It says nothing about an Agent nobody is activating.
    expect(context.isAgentConfigurationActivationPending('someone-else')).toBe(
      false,
    );

    // It stays true across the whole window, including while the pass runs.
    await vi.waitFor(() => expect(events).toContain('reconcile-start'));
    expect(context.isAgentConfigurationActivationPending('writer')).toBe(true);

    releaseReconciliation();
    await vi.waitFor(() =>
      expect(context.isAgentConfigurationActivationPending('writer')).toBe(
        false,
      ),
    );
  });

  test('(F1) a pass that never saw the new agent cannot retire it, and the successor activates it', async () => {
    // The race: `agentConfigurationPersistenceRevision` increments when the
    // durable write BEGINS, so a pass already running can capture the new
    // revision, read the agents directory before the file lands, and still
    // succeed — after create marked its slug. A wholesale clear retired a slug
    // that pass never saw, and the successor pass could take the loaded-state
    // fast path and no-op, leaving the Agent at 409 forever.
    const { runtime, events } = harness();
    runtime.providerService = { getLaunchabilityRevision: () => 0 };
    runtime.configLoader = { getLaunchabilityRevision: () => 0 };
    runtime.appConfig = { region: 'us-east-1' };
    const context = runtime.buildRuntimeContext();

    let releaseFirstPass!: () => void;
    const firstPassReading = new Promise<void>((resolve) => {
      releaseFirstPass = resolve;
    });
    let pass = 0;
    runtime.reloadAgentsFromDisk = vi.fn(async () => {
      pass += 1;
      const generation = pass;
      events.push(`pass-${generation}-read`);
      if (generation === 1) {
        // Reads the directory BEFORE the create's file lands, then finishes
        // after it has been marked.
        await firstPassReading;
        events.push('pass-1-end');
        return;
      }
      // Every later pass sees the file.
      runtime.agentMetadataMap.set('writer', { slug: 'writer' });
      events.push(`pass-${generation}-end`);
    });

    // A pass is already in flight when the create lands.
    runtime.markAgentAwaitingReconciliation('unrelated');
    runtime.scheduleAgentConfigurationReconciliation();
    await vi.waitFor(() => expect(events).toContain('pass-1-read'));

    await expect(deferredCreate(runtime, 'writer')).resolves.toEqual({
      slug: 'writer',
    });
    expect(context.isAgentConfigurationActivationPending('writer')).toBe(true);

    // The in-flight pass now SUCCEEDS — without ever having read `writer`.
    releaseFirstPass();
    await vi.waitFor(() => expect(events).toContain('pass-1-end'));
    expect(context.isAgentConfigurationActivationPending('writer')).toBe(true);

    // …and the successor pass, which must NOT take the no-op fast path,
    // actually activates it.
    runtime.runtimeConfigurationSourcesAreLoaded = () => true;
    await vi.waitFor(
      () =>
        expect(context.isAgentConfigurationActivationPending('writer')).toBe(
          false,
        ),
      { timeout: 5000 },
    );
    expect(runtime.agentMetadataMap.has('writer')).toBe(true);
    runtime.agentConfigurationMutationsClosed = true;
  });

  test('(F2) an activation that keeps failing is retired with its reason, not retried forever', async () => {
    // Non-transient preparation failures reject the whole pass and
    // reconciliation retries indefinitely, so the slug reported 503
    // "activating" — with a Retry-After — for the life of the process.
    const { runtime } = harness();
    runtime.providerService = { getLaunchabilityRevision: () => 0 };
    runtime.configLoader = { getLaunchabilityRevision: () => 0 };
    runtime.appConfig = { region: 'us-east-1' };
    const context = runtime.buildRuntimeContext();
    let attempts = 0;
    runtime.reloadAgentsFromDisk = vi.fn(async () => {
      attempts += 1;
      throw new Error('prompt template references a missing variable');
    });

    await deferredCreate(runtime, 'writer');
    // It stays "activating" while the retries are genuinely happening.
    await vi.waitFor(() => expect(attempts).toBeGreaterThan(0));
    expect(context.isAgentConfigurationActivationPending('writer')).toBe(true);
    expect(context.getAgentActivationFailure('writer')).toBeUndefined();

    // …and then stops, with the actual reason.
    await vi.waitFor(
      () =>
        expect(context.isAgentConfigurationActivationPending('writer')).toBe(
          false,
        ),
      { timeout: 10_000 },
    );
    expect(context.getAgentActivationFailure('writer')).toMatchObject({
      reason: 'prompt template references a missing variable',
    });
    expect(
      Date.parse(context.getAgentActivationFailure('writer').at),
    ).not.toBeNaN();
    runtime.agentConfigurationMutationsClosed = true;
  });

  test('(F2) a later write clears the recorded failure — it accused the previous bytes', async () => {
    const { runtime } = harness();
    runtime.providerService = { getLaunchabilityRevision: () => 0 };
    runtime.configLoader = { getLaunchabilityRevision: () => 0 };
    runtime.appConfig = { region: 'us-east-1' };
    const context = runtime.buildRuntimeContext();
    runtime.reloadAgentsFromDisk = vi.fn(async () => {
      throw new Error('broken');
    });
    await deferredCreate(runtime, 'writer');
    // Three passes across the whole backoff rail (250ms, 1s, 5s).
    await vi.waitFor(
      () => expect(context.getAgentActivationFailure('writer')).toBeDefined(),
      { timeout: 10_000 },
    );

    runtime.reloadAgentsFromDisk = vi.fn(async () => {
      runtime.agentMetadataMap.set('writer', { slug: 'writer' });
    });
    await deferredCreate(runtime, 'writer');
    expect(context.getAgentActivationFailure('writer')).toBeUndefined();
    expect(context.isAgentConfigurationActivationPending('writer')).toBe(true);
    runtime.agentConfigurationMutationsClosed = true;
  });

  test('(b) a never-settling activation does not block a later unrelated mutation', async () => {
    // The liveness proof. Under `'wait'` the activation ran inside both
    // serialized queues, so this second mutation could never start.
    const { runtime, events } = harness();
    runtime.reloadAgentsFromDisk = vi.fn(async () => {
      events.push('reconcile-start');
      await new Promise<void>(() => {});
    });

    await expect(deferredCreate(runtime, 'writer')).resolves.toEqual({
      slug: 'writer',
    });
    await vi.waitFor(() => expect(events).toContain('reconcile-start'));

    // A completely unrelated second mutation, with the first one's activation
    // wedged open forever.
    const second = deferredCreate(runtime, 'planner');
    await expect(second).resolves.toEqual({ slug: 'planner' });
    expect(events).toEqual(['reconcile-start']);
  });

  test('a failed reconciliation keeps the slug activating WHILE retries remain', async () => {
    // The discriminating half: clearing on ANY outcome would report the Agent
    // simply inactive while a retry was already in flight. (It stops after
    // `MAX_ACTIVATION_ATTEMPTS` — see the F2 test above.)
    const { runtime } = harness();
    runtime.providerService = { getLaunchabilityRevision: () => 0 };
    runtime.configLoader = { getLaunchabilityRevision: () => 0 };
    runtime.appConfig = { region: 'us-east-1' };
    const context = runtime.buildRuntimeContext();
    let attempts = 0;
    runtime.reloadAgentsFromDisk = vi.fn(async () => {
      attempts += 1;
      throw new Error('reconciliation failed');
    });

    await deferredCreate(runtime, 'writer');
    await vi.waitFor(() => expect(attempts).toBeGreaterThan(0));
    expect(context.isAgentConfigurationActivationPending('writer')).toBe(true);
    runtime.agentConfigurationMutationsClosed = true;
  });

  test('a wait-mode narrow activation is tracked in flight for its slug', async () => {
    // The other half of the same signal: while a narrow activation IS
    // executing, that slug is activating too.
    const { runtime, events } = harness();
    runtime.providerService = { getLaunchabilityRevision: () => 0 };
    runtime.configLoader = { getLaunchabilityRevision: () => 0 };
    runtime.appConfig = { region: 'us-east-1' };
    const context = runtime.buildRuntimeContext();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.reloadPersistedAgentFromDisk = vi.fn(async (slug: string) => {
      events.push(`activation-start:${slug}`);
      await gate;
      events.push(`activation-end:${slug}`);
    });
    runtime.reloadAgentsFromDisk = vi.fn();

    const mutation = runtime.applyAgentConfigurationMutation(
      (beginMutation: () => void) => {
        beginMutation();
        return Promise.resolve({ slug: 'writer' });
      },
      {
        resolveAgentSlug: (result: { slug: string }) => result.slug,
        activationMode: 'wait',
      },
    );

    await vi.waitFor(() => expect(events).toEqual(['activation-start:writer']));
    expect(context.isAgentConfigurationActivationPending('writer')).toBe(true);

    release();
    await expect(mutation).resolves.toEqual({ slug: 'writer' });
    expect(context.isAgentConfigurationActivationPending('writer')).toBe(false);
  });

  test('wait mode still waits — its semantics are unchanged by any of this', async () => {
    const { runtime } = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.reloadPersistedAgentFromDisk = vi.fn(async () => {
      await gate;
    });
    runtime.reloadAgentsFromDisk = vi.fn();
    let resolved = false;
    const mutation = runtime
      .applyAgentConfigurationMutation(
        (beginMutation: () => void) => {
          beginMutation();
          return Promise.resolve({ slug: 'writer' });
        },
        {
          resolveAgentSlug: (result: { slug: string }) => result.slug,
          activationMode: 'wait',
        },
      )
      .then((value: unknown) => {
        resolved = true;
        return value;
      });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(resolved).toBe(false);
    release();
    await expect(mutation).resolves.toEqual({ slug: 'writer' });
  });
});

describe('StationRuntime: a wait-mode activation is bounded (station#3622)', () => {
  /**
   * Connection, provider and plugin mutations activate synchronously so their
   * response describes a live runtime. Before this bound, that activation ran
   * inside BOTH configuration queues with no deadline, so one hanging provider
   * probe or unresponsive MCP server wedged every later configuration mutation
   * and shutdown behind it.
   */
  function boundedHarness() {
    const built = harness();
    // Short enough that the whole file stays fast; the production default is
    // AGENT_CONFIGURATION_ACTIVATION_DEADLINE_MS.
    built.runtime.agentConfigurationActivationDeadlineMs = 25;
    built.runtime.agentConfigurationShutdownDrainGraceMs = 25;
    return built;
  }

  /** A connection/provider/plugin-shaped mutation: 'wait', no agent slug. */
  function immediateMutation(runtime: any, label: string) {
    const receipts: Array<{ status: string; reason?: string }> = [];
    const settled = runtime.applyAgentConfigurationMutation(
      (beginMutation: () => void, activation: any) => {
        beginMutation();
        receipts.push(activation);
        return Promise.resolve({ label });
      },
      { activationMode: 'wait' as const },
    );
    return { settled, receipts };
  }

  test('a never-settling activation does not block a later unrelated mutation', async () => {
    const { runtime, events } = boundedHarness();
    let stalledStarted = false;
    runtime.reloadAgentsFromDisk = vi.fn(async () => {
      if (!stalledStarted) {
        stalledStarted = true;
        events.push('stalled-activation-start');
        await new Promise<void>(() => {});
      }
      events.push('second-activation');
    });

    const first = immediateMutation(runtime, 'connection');
    await expect(first.settled).resolves.toEqual({ label: 'connection' });
    expect(events).toContain('stalled-activation-start');

    // The activation is still running — and the queues are free anyway.
    const second = immediateMutation(runtime, 'provider');
    await expect(second.settled).resolves.toEqual({ label: 'provider' });
  }, 10_000);

  test('the deadline is reported as a pending activation receipt, not as applied', async () => {
    // This is what makes the routes answer 202 with
    // `configurationActivation: 'pending'` — see
    // `configurationMutationStatus` / `configurationActivationPayload`.
    const { runtime } = boundedHarness();
    runtime.reloadAgentsFromDisk = vi.fn(async () => {
      await new Promise<void>(() => {});
    });

    const { settled, receipts } = immediateMutation(runtime, 'connection');
    await expect(settled).resolves.toEqual({ label: 'connection' });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ status: 'pending' });
    expect(receipts[0].reason).toContain('deadline');
  }, 10_000);

  test('a fast activation still reports applied — the bound is a ceiling, not a policy', async () => {
    const { runtime } = boundedHarness();
    runtime.reloadAgentsFromDisk = vi.fn(async () => {});

    const { settled, receipts } = immediateMutation(runtime, 'connection');
    await expect(settled).resolves.toEqual({ label: 'connection' });
    expect(receipts[0]).toMatchObject({ status: 'applied' });
    expect(receipts[0].reason).toBeUndefined();
  }, 10_000);

  test('an abandoned activation cannot publish after the queues moved on', async () => {
    // The reason releasing the lease is safe: the abandoned pass prepared
    // against a generation the epoch bump has invalidated, so its own
    // publication gate rejects it.
    const { runtime } = boundedHarness();
    runtime.providerService = { getLaunchabilityRevision: () => 0 };
    runtime.configLoader = { getLaunchabilityRevision: () => 0 };
    const before = runtime.captureAgentConfigurationRevisions();
    expect(() =>
      runtime.assertAgentConfigurationRevisions(before),
    ).not.toThrow();

    runtime.abandonStalledActivation(undefined, new Promise<void>(() => {}));

    expect(() => runtime.assertAgentConfigurationRevisions(before)).toThrow(
      /Runtime configuration changed/,
    );
    runtime.agentConfigurationMutationsClosed = true;
  });

  test('shutdown completes with an activation still stalled', async () => {
    const { runtime, events } = boundedHarness();
    runtime.reloadAgentsFromDisk = vi.fn(async () => {
      events.push('stalled-activation-start');
      await new Promise<void>(() => {});
    });
    const { settled } = immediateMutation(runtime, 'connection');
    await expect(settled).resolves.toEqual({ label: 'connection' });

    // Wedge the access queue the way a pre-#3622 activation did, so the drain
    // has something that genuinely never settles to wait on.
    runtime.serializeAgentConfigurationAccess(
      () => new Promise<void>(() => {}),
    );
    runtime.agentConfigurationMutationsClosed = true;

    const started = Date.now();
    await expect(runtime.drainConfigurationQueues()).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(runtime.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('did not drain before shutdown'),
      expect.objectContaining({ graceMs: 25 }),
    );
  }, 10_000);

  test('a drained queue does not spend the grace period', async () => {
    // The discriminating half: without this, a drain that simply always waited
    // out its grace would satisfy the test above.
    const { runtime } = boundedHarness();
    runtime.agentConfigurationShutdownDrainGraceMs = 5_000;
    runtime.agentConfigurationMutationsClosed = true;
    const started = Date.now();
    await runtime.drainConfigurationQueues();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(runtime.logger.warn).not.toHaveBeenCalled();
  });
});
