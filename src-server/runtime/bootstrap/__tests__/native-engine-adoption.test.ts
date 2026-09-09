// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadOrCreateAgentRegistry,
  materializeStationAgent,
  registerEngineConnection,
  withoutReservedStationBinding,
} from '../../../domain/agent-registry.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import {
  ADOPTION_PROBE_TIMEOUT_MS,
  adoptDetectedNativeEngines,
  NATIVE_ENGINE_CANDIDATES,
  SUPPRESS_NATIVE_ENGINE_ADOPTION_ENV,
} from '../native-engine-adoption.js';

const homes: string[] = [];
const createLoader = () => {
  const home = mkdtempSync(join(tmpdir(), 'station-native-adoption-'));
  homes.push(home);
  return new ConfigLoader({ projectHomeDir: home });
};

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

const silentLogger = { info: vi.fn(), warn: vi.fn() };

/**
 * How long the cases below wait for a probe to be invoked (station#1815).
 *
 * Stated rather than defaulted, and below vitest's own 30s `testTimeout` so
 * it can fire FIRST: a wait equal to the framework's deadline can only ever
 * be reported as "the test timed out", never as "the probes never ran",
 * which is the diagnostic these waits exist to give.
 *
 * The number is also, coincidentally, the file mutation lock's admission
 * deadline — which sits INSIDE the registry work every one of these waits
 * spans. A single contended admission would make the wait fire first and
 * blame the probes for lock contention. Not reachable in this file, because
 * every case takes its own fresh home from `createLoader`, and recorded here
 * rather than at one call site because it is a property of the value, not of
 * whichever wait happens to carry the note.
 */
const PROBE_WAIT_MS = 10_000;

/**
 * A `station` record as an OLDER build left it — carrying an engine binding.
 *
 * It has to be written to disk directly: since archive#3662 delta H3 the
 * write boundary strips `execution.agentConnectionId` for this one identity
 * (`AppConfig.builtinAgentEngineConnectionId` owns it), so `createAgent`
 * cannot produce the state these heal tests exist to heal. Writing the file
 * is not a shortcut around the rule — a legacy home IS a file the current
 * writer would not have written.
 */
async function seedLegacyStationRecord(
  loader: ConfigLoader,
  execution: Record<string, unknown>,
): Promise<void> {
  await loader.createAgent({
    slug: 'station',
    name: 'Station',
    prompt: '',
  } as never);
  const path = join(
    loader.getProjectHomeDir(),
    'agents',
    'station',
    'agent.json',
  );
  const spec = JSON.parse(readFileSync(path, 'utf-8'));
  writeFileSync(path, JSON.stringify({ ...spec, execution }, null, 2));
}

describe('adoptDetectedNativeEngines (#1575)', () => {
  it('adopts every detected CLI into the registry', async () => {
    const loader = createLoader();
    const summary = await adoptDetectedNativeEngines({
      configLoader: loader,
      logger: silentLogger,
      detect: async () => true,
      delaysMs: [0],
    });

    expect(summary.outcomes).toEqual({
      claude: 'adopted',
      codex: 'adopted',
      muse: 'adopted',
    });
    const registry = await loadOrCreateAgentRegistry(loader);
    expect(registry.engineConnections.map((c) => c.id).sort()).toEqual([
      'claude',
      'codex',
      'muse',
    ]);
    expect(
      registry.defaultAgents.filter((a) => a.kind === 'engine-connection'),
    ).toHaveLength(3);
    const agents = await loader.listAgents();
    expect(agents.map((agent) => agent.slug).sort()).toEqual([
      'claude',
      'codex',
      'muse',
      'station',
    ]);
    await expect(loader.loadAgent('claude')).resolves.toMatchObject({
      name: 'Claude Code',
      execution: { agentConnectionId: 'claude' },
      provenance: { origin: 'engine-detection', engineId: 'claude' },
    });
  });

  it('an already-registered EXACT native connection settles as exists, not a collision', async () => {
    // The complement of the collision test below: `connection-collision` must
    // be reserved for a genuinely foreign connection. If it also fired for the
    // engine's own record, every reboot after the first would refuse to
    // materialize the engine's Agent — the ordinary steady state.
    const loader = createLoader();
    // The engine's own record uses the same canonical id and source.
    const [claudeCandidate] = NATIVE_ENGINE_CANDIDATES.filter(
      (candidate) => candidate.id === 'claude',
    );
    await registerEngineConnection(loader, claudeCandidate.id, {
      kind: 'native',
    });

    const summary = await adoptDetectedNativeEngines({
      configLoader: loader,
      logger: silentLogger,
      detect: async () => true,
      delaysMs: [0],
    });

    expect(summary.outcomes.claude).toBe('exists');
    // …and 'exists' still materializes, so a home whose connection was
    // registered before this branch existed still gains its Agent.
    await expect(loader.loadAgent('claude')).resolves.toMatchObject({
      name: 'Claude Code',
      execution: { agentConnectionId: 'claude' },
      provenance: { origin: 'engine-detection', engineId: 'claude' },
    });
  });

  it('never brands a foreign connection sharing a native id as that engine', async () => {
    // A user's own ACP command registered as `claude`. Detection then finds
    // the real Claude CLI on PATH. The id is taken by something else, so the
    // registration collides — and folding that collision into 'exists' had
    // bootstrap materialize an Agent named "Claude Code" bound to the
    // stranger's engine.
    const loader = createLoader();
    await registerEngineConnection(loader, 'claude', {
      kind: 'user-acp',
    });

    const summary = await adoptDetectedNativeEngines({
      configLoader: loader,
      logger: silentLogger,
      detect: async () => true,
      delaysMs: [0],
    });

    expect(summary.outcomes.claude).toBe('connection-collision');
    const agents = await loader.listAgents();
    // No Agent was created for the colliding id under the native brand.
    expect(agents.some((agent) => agent.slug === 'claude')).toBe(false);
    // The user's connection is untouched, and the genuinely-native engines
    // are unaffected by their neighbour's collision.
    const registry = await loadOrCreateAgentRegistry(loader);
    expect(
      registry.engineConnections.find((c) => c.id === 'claude'),
    ).toMatchObject({ source: { kind: 'user-acp' } });
    expect(summary.outcomes.codex).toBe('adopted');
    await expect(loader.loadAgent('codex')).resolves.toMatchObject({
      name: 'Codex',
    });
  });

  it('retries a CLI that appears late — the original one-shot race (#1575)', async () => {
    const loader = createLoader();
    let attempt = 0;
    const detect = vi.fn(async (cli: string) => {
      if (cli === 'codex') return true;
      attempt += 1;
      // claude's probe loses the first race and wins the second.
      return attempt > 1;
    });

    const summary = await adoptDetectedNativeEngines({
      configLoader: loader,
      logger: silentLogger,
      detect,
      delaysMs: [0, 1],
    });

    expect(summary.outcomes).toEqual({
      claude: 'adopted',
      codex: 'adopted',
      muse: 'adopted',
    });
  });

  it('leaves an undetected CLI absent without inventing a connection', async () => {
    const loader = createLoader();
    const summary = await adoptDetectedNativeEngines({
      configLoader: loader,
      logger: silentLogger,
      detect: async (cli) => cli === 'claude',
      delaysMs: [0, 1],
    });

    expect(summary.outcomes).toEqual({
      claude: 'adopted',
      codex: 'absent',
      muse: 'absent',
    });
    const registry = await loadOrCreateAgentRegistry(loader);
    expect(registry.engineConnections.map((c) => c.id)).toEqual(['claude']);
  });

  it('is idempotent across restarts and honors an existing registry', async () => {
    const loader = createLoader();
    const run = () =>
      adoptDetectedNativeEngines({
        configLoader: loader,
        logger: silentLogger,
        detect: async () => true,
        delaysMs: [0],
      });

    await run();
    const second = await run();
    expect(second.outcomes).toEqual({
      claude: 'exists',
      codex: 'exists',
      muse: 'exists',
    });
    const registry = await loadOrCreateAgentRegistry(loader);
    expect(registry.engineConnections).toHaveLength(3);
  });

  it('settles promptly when the shutdown signal aborts a pending delay (#1575)', async () => {
    const loader = createLoader();
    const controller = new AbortController();
    // All-absent detection: attempt 1's candidate loop does zero registry
    // I/O, so once every candidate has been probed the run is INSIDE the 600s
    // delay and a broken abort listener cannot hide behind the outer loop
    // guard (the archive#1575 verifier proved the previous shape never
    // reached the listener).
    //
    // Keyed on the probes rather than on a 20ms sleep (station#1815): the
    // registry load and Station-Agent materialization that run BEFORE the
    // loop are real file I/O, so on a loaded host the abort could land before
    // any candidate was probed. That used to be invisible because the summary
    // reported 'absent' either way; now that an unprobed candidate says
    // 'interrupted', the assertion below is only true if the probes really
    // ran, and this wait is what makes that so.
    //
    // What this case does NOT pin, and the sentence above should not be read
    // as claiming: that the abort lands INSIDE the delay rather than at the
    // top-of-iteration guard. Both settle promptly and produce this same
    // summary. The #1815 round-2 reviewer injected the listener away and this
    // case timed out, so on that host it was inside the delay and the
    // listener was load-bearing — but that is poll granularity, not something
    // asserted here.
    const detect = vi.fn(async () => false);

    const pending = adoptDetectedNativeEngines({
      configLoader: loader,
      logger: silentLogger,
      detect,
      // Without a working in-delay abort this settles only after ~10 minutes.
      delaysMs: [0, 600_000],
      signal: controller.signal,
    });
    await vi.waitFor(
      () =>
        expect(detect).toHaveBeenCalledTimes(NATIVE_ENGINE_CANDIDATES.length),
      // Stated, not defaulted: the default is 1s and this wait spans a real
      // registry load and Station-Agent materialization — file I/O, on
      // exactly the loaded hosts that motivated replacing the sleep here.
      // Below vitest's own 30s `testTimeout`, deliberately: a value equal to
      // it can never fire first, and the diagnostic this wait was given
      // ("the probes never ran") would be unreachable.
      // See `PROBE_WAIT_MS` for why the number itself deserves a note.
      { timeout: PROBE_WAIT_MS, interval: 5 },
    );
    // The span starts HERE, not at the call. Everything before the abort —
    // the registry load, the Station-Agent materialization, three probes — is
    // setup, and folding it into a promptness bound both inflates the bound
    // and lets setup cost be attributed to the abort listener.
    const abortedAt = Date.now();
    controller.abort();

    const summary = await pending;
    expect(Date.now() - abortedAt).toBeLessThan(5_000);
    expect(summary.outcomes).toEqual({
      claude: 'absent',
      codex: 'absent',
      muse: 'absent',
    });
  });

  it('carries the shutdown signal and a probe ceiling into every probe (#1815)', async () => {
    const loader = createLoader();
    const controller = new AbortController();
    const detect = vi.fn(async () => false);

    await adoptDetectedNativeEngines({
      configLoader: loader,
      logger: silentLogger,
      detect,
      delaysMs: [0],
      signal: controller.signal,
    });

    // Without the signal reaching `detectCliOnPath` there is no way to end a
    // probe already running, and shutdown's only options were to hang or to
    // stop waiting and release the home under it.
    expect(detect).toHaveBeenCalledTimes(NATIVE_ENGINE_CANDIDATES.length);
    for (const call of detect.mock.calls as unknown as Array<
      [string, { signal?: AbortSignal; timeoutMs?: number } | undefined]
    >) {
      expect(call[1]?.signal).toBe(controller.signal);
      expect(call[1]?.timeoutMs).toBe(ADOPTION_PROBE_TIMEOUT_MS);
    }
  });

  it('does not adopt a probe that answered after the abort (#1815)', async () => {
    const loader = createLoader();
    const controller = new AbortController();
    let answerProbe!: (found: boolean) => void;
    const probed = new Promise<boolean>((resolve) => {
      answerProbe = resolve;
    });
    // One probe, held open. The abort lands while it is in flight, which is
    // exactly the window the runtime could not account for.
    const detect = vi.fn(() => probed);

    const pending = adoptDetectedNativeEngines({
      configLoader: loader,
      logger: silentLogger,
      detect,
      delaysMs: [0],
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(detect).toHaveBeenCalledTimes(1), {
      timeout: PROBE_WAIT_MS,
      interval: 5,
    });
    controller.abort();
    // The real probe resolves false on abort; a detector that answers TRUE
    // anyway is the discriminating case — it proves the write is stopped by
    // the adoption's own guard and not merely by the probe's answer.
    answerProbe(true);

    const summary = await pending;
    // 'interrupted', not 'absent'. `claude`'s probe answered TRUE and the
    // guard stopped the write; `codex` and `muse` were never probed at all.
    // Reporting any of those as absence would state a host fact nothing here
    // observed, in the field where 'absent' means a probe said no.
    expect(summary.outcomes).toEqual({
      claude: 'interrupted',
      codex: 'interrupted',
      muse: 'interrupted',
    });
    // The observable is the WRITE, not a timer: nothing reached the registry.
    const registry = await loadOrCreateAgentRegistry(loader);
    expect(registry.engineConnections).toEqual([]);
    // And no further candidate started a probe of its own under the abort.
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it('elides the next candidate probe when the abort lands during a write (#1815)', async () => {
    const loader = createLoader();
    const controller = new AbortController();
    // The window the loop's pre-probe check covers on its own: candidate 1's
    // probe answered and was NOT aborted, so the post-probe check let it
    // through, and the abort lands inside the registry write that probe
    // authorised. By the time the loop reaches candidate 2 the check before
    // its probe is the only one left.
    //
    // Hermetic, which three earlier rounds of this comment claimed it could
    // not be. The detector mirrors the shipped one in the only respect that
    // matters here — `detectCliOnPath` resolves falsy WITHOUT spawning when
    // its signal is already aborted — so candidate 2 takes exactly the path a
    // host with the CLI installed takes. What is injected is the "yes, it is
    // installed" answer, not the control flow.
    const detect = vi.fn(
      async (_cli: string, options?: { signal?: AbortSignal }) =>
        !options?.signal?.aborted,
    );
    // `materializeEngineAgent` is the only caller of `listAgents` on this
    // path, so the abort lands once, inside a real await, after candidate 1's
    // connection write has begun.
    const abortingDuringWrite = new Proxy(loader, {
      get(target, prop, receiver) {
        if (prop === 'listAgents') {
          return async () => {
            controller.abort();
            return await loader.listAgents();
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ConfigLoader;

    const summary = await adoptDetectedNativeEngines({
      configLoader: abortingDuringWrite,
      logger: silentLogger,
      detect,
      delaysMs: [0],
      signal: controller.signal,
    });

    // The whole observable difference. Without the pre-probe check candidate 2
    // is probed, its detector returns falsy because the signal is aborted, and
    // the post-probe check then breaks — so the outcomes below are identical
    // either way and the call count is the only thing that moves.
    expect(detect).toHaveBeenCalledTimes(1);
    expect(summary.outcomes).toEqual({
      claude: 'adopted',
      codex: 'interrupted',
      muse: 'interrupted',
    });
    // Candidate 1's write completed: the check stops the NEXT candidate, it
    // does not abandon a write already under way.
    const registry = await loadOrCreateAgentRegistry(loader);
    expect(registry.engineConnections.map((c) => c.id)).toEqual(['claude']);
  });

  it('reports a probe CANCELLED in flight as interrupted, not absent (#1815)', async () => {
    const loader = createLoader();
    const controller = new AbortController();
    let answerProbe!: (found: boolean) => void;
    const probed = new Promise<boolean>((resolve) => {
      answerProbe = resolve;
    });
    const detect = vi.fn(() => probed);

    const pending = adoptDetectedNativeEngines({
      configLoader: loader,
      logger: silentLogger,
      detect,
      delaysMs: [0],
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(detect).toHaveBeenCalledTimes(1), {
      timeout: PROBE_WAIT_MS,
      interval: 5,
    });
    controller.abort();
    // FALSE, which is what the real probe does here: `detectCliOnPath`
    // resolves false on abort rather than rejecting. This is the common
    // shape by a wide margin — an abort lands inside the `which` child for
    // the probe's whole duration, while the guards on either side of it are
    // a few instructions — and the first version of this fix reported it as
    // 'absent' for a `claude` that may well be installed.
    answerProbe(false);

    const summary = await pending;
    expect(summary.outcomes).toEqual({
      claude: 'interrupted',
      codex: 'interrupted',
      muse: 'interrupted',
    });
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it('keeps an earlier observed absence a later cancelled probe cannot correct (#1815)', async () => {
    const loader = createLoader();
    const controller = new AbortController();
    let calls = 0;
    // Attempt 1 observes all three absent. Attempt 2 finds `claude` present
    // and is stopped before it can write — so the summary must carry the
    // LATER observation for `claude`, which the backfill's `??=` could never
    // have done, while `codex` and `muse` keep the absence attempt 1 really
    // did observe.
    const detect = vi.fn(async () => {
      calls += 1;
      if (calls <= NATIVE_ENGINE_CANDIDATES.length) return false;
      controller.abort();
      return true;
    });

    const summary = await adoptDetectedNativeEngines({
      configLoader: loader,
      logger: silentLogger,
      detect,
      delaysMs: [0, 1],
      signal: controller.signal,
    });
    expect(summary.outcomes).toEqual({
      claude: 'interrupted',
      codex: 'absent',
      muse: 'absent',
    });
    const registry = await loadOrCreateAgentRegistry(loader);
    expect(registry.engineConnections).toEqual([]);
  });

  it('reports the screenshot containment as suppressed, not absent (#1815)', async () => {
    const loader = createLoader();
    const detect = vi.fn(async () => true);

    const summary = await adoptDetectedNativeEngines({
      configLoader: loader,
      logger: silentLogger,
      detect,
      delaysMs: [0],
      env: {
        [SUPPRESS_NATIVE_ENGINE_ADOPTION_ENV]: '1',
        STATION_HOME_SOURCE: '--temp-home',
        STATION_INSTANCE_ID: 'e2e-screenshot-mes5x00-abc123',
      },
    });

    // Zero probes were made, so an absence would be a claim about a host
    // nothing looked at — and this path made it for all three candidates.
    expect(detect).not.toHaveBeenCalled();
    expect(summary.outcomes).toEqual({
      claude: 'suppressed',
      codex: 'suppressed',
      muse: 'suppressed',
    });
    // The containment itself is unchanged: nothing was adopted.
    const registry = await loadOrCreateAgentRegistry(loader);
    expect(registry.engineConnections).toEqual([]);
  });

  it('leaves a partially adopted registry the next run completes (#1815)', async () => {
    const loader = createLoader();
    const controller = new AbortController();
    // The abort lands while the SECOND candidate's probe is in flight, so
    // `claude` is adopted and `codex`/`muse` are not. That partial registry is
    // the whole cost of the new abort guards, and it is only acceptable if the
    // next run repairs it — the existing idempotency case covers the
    // all-or-nothing shape and cannot say anything about this one.
    const detect = vi.fn(async (cli: string) => {
      if (cli === 'codex') controller.abort();
      return true;
    });

    const interrupted = await adoptDetectedNativeEngines({
      configLoader: loader,
      logger: silentLogger,
      detect,
      delaysMs: [0],
      signal: controller.signal,
    });
    expect(interrupted.outcomes).toEqual({
      claude: 'adopted',
      codex: 'interrupted',
      muse: 'interrupted',
    });
    const partial = await loadOrCreateAgentRegistry(loader);
    expect(partial.engineConnections.map((c) => c.id)).toEqual(['claude']);

    const repaired = await adoptDetectedNativeEngines({
      configLoader: loader,
      logger: silentLogger,
      detect: async () => true,
      delaysMs: [0],
    });
    expect(repaired.outcomes).toEqual({
      claude: 'exists',
      codex: 'adopted',
      muse: 'adopted',
    });
    const registry = await loadOrCreateAgentRegistry(loader);
    expect(registry.engineConnections.map((c) => c.id).sort()).toEqual([
      'claude',
      'codex',
      'muse',
    ]);
    // The Agents behind them, not just the connections.
    for (const id of ['claude', 'codex', 'muse']) {
      await expect(loader.loadAgent(id)).resolves.toMatchObject({
        execution: { agentConnectionId: id },
      });
    }
  });

  it('never throws when the registry write fails; settles as error', async () => {
    const loader = createLoader();
    const broken = new Proxy(loader, {
      get(target, prop, receiver) {
        if (prop === 'getProjectHomeDir') {
          return () => {
            throw new Error('boom');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ConfigLoader;

    const summary = await adoptDetectedNativeEngines({
      configLoader: broken,
      logger: silentLogger,
      detect: async () => true,
      delaysMs: [0],
    });
    expect(summary.outcomes).toEqual({
      claude: 'error',
      codex: 'error',
      muse: 'error',
    });
    expect(silentLogger.warn).toHaveBeenCalled();
  });
});

describe('native engine candidates', () => {
  it('adopts muse under its engine id', () => {
    const muse = NATIVE_ENGINE_CANDIDATES.find(
      (candidate) => candidate.id === 'muse',
    );
    expect(muse).toEqual({
      id: 'muse',
      cli: 'muse',
    });
  });

  it('binds every candidate to a distinct id and cli', () => {
    const ids = NATIVE_ENGINE_CANDIDATES.map((c) => c.id);
    const clis = NATIVE_ENGINE_CANDIDATES.map((c) => c.cli);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(clis).size).toBe(clis.length);
  });
});

describe("the Station Agent's own definition (#3662)", () => {
  it('is seeded with NO engine binding — Station is not an engine connection', async () => {
    // The registry refuses `station` as an engine connection outright
    // (ReservedStationIdentityError), so a seeded
    // `execution.agentConnectionId: 'station'` named a connection that can
    // never exist. Every consumer that resolves the binding then disagreed
    // with every consumer that does not: `POST /api/orchestration/chat`
    // answered "Connection not found", the catalog reported "Engine
    // connection 'station' is not configured.", and the new-chat picker
    // offered nothing on a home /api/system/status called chat-ready.
    const loader = createLoader();
    await adoptDetectedNativeEngines({
      configLoader: loader,
      logger: silentLogger,
      detect: async () => false,
      delaysMs: [0],
    });

    const station = await loader.loadAgent('station');
    expect(station.name).toBe('Station');
    expect(station.execution?.agentConnectionId).toBeUndefined();
    // And the registry still owns the identity, unchanged.
    const registry = await loadOrCreateAgentRegistry(loader);
    expect(registry.defaultAgents).toContainEqual({
      id: 'station',
      kind: 'station',
    });
    await expect(loader.loadAgent('station')).resolves.toMatchObject({
      tools: { mcpServers: ['station-control', 'station-docs'] },
    });
  });

  it('heals an existing home at load, keeping everything else on execution', async () => {
    const loader = createLoader();
    await seedLegacyStationRecord(loader, {
      agentConnectionId: 'station',
      modelId: 'my-pinned-model',
    });
    await expect(loader.loadAgent('station')).resolves.toMatchObject({
      execution: { agentConnectionId: 'station' },
    });

    await materializeStationAgent(loader);

    const healed = await loader.loadAgent('station');
    expect(healed.execution?.agentConnectionId).toBeUndefined();
    // The user's own model pin is not collateral damage.
    expect(healed.execution?.modelId).toBe('my-pinned-model');
  });

  it('drops an execution block that carried nothing but the dead binding', async () => {
    const loader = createLoader();
    await seedLegacyStationRecord(loader, { agentConnectionId: 'station' });

    expect(await materializeStationAgent(loader)).toEqual({
      created: false,
      healed: true,
    });
    expect((await loader.loadAgent('station')).execution).toBeUndefined();
  });

  it('writes nothing once healed — this runs on every start (#1588)', async () => {
    // A reload that rewrites its own watched input is the self-write→watcher
    // loop. The write must be gated on the dead binding actually being there.
    const loader = createLoader();
    expect(await materializeStationAgent(loader)).toEqual({
      created: true,
      healed: false,
    });

    const saveAgent = vi.spyOn(loader, 'saveAgent');
    const createAgent = vi.spyOn(loader, 'createAgent');
    expect(await materializeStationAgent(loader)).toEqual({
      created: false,
      healed: false,
    });
    expect(saveAgent).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('heals a REAL engine binding off the Station record too (delta H3)', async () => {
    // Round 1 healed only the impossible `station` binding and deliberately
    // left a real one ("the user rebound it and owns that choice"). The delta
    // showed why that cannot hold: the catalog projects the RUNTIME binding
    // onto this identity, the editor loads the projection into its form, and
    // any unrelated save writes it back — so `claude` on disk is usually not
    // a choice at all, it is last boot's resolution frozen into a file. It
    // then outlives the boot that produced it: the next start with Claude
    // Code unavailable resolves to Station's own engine while the record
    // still says Claude.
    //
    // `AppConfig.builtinAgentEngineConnectionId` is the one place that choice
    // lives (§7.1.1), so the record carries no binding at all.
    const loader = createLoader();
    await registerEngineConnection(loader, 'claude');
    await seedLegacyStationRecord(loader, {
      agentConnectionId: 'claude',
      modelId: 'my-pinned-model',
    });

    expect(await materializeStationAgent(loader)).toEqual({
      created: false,
      healed: true,
    });
    const healed = await loader.loadAgent('station');
    expect(healed.execution?.agentConnectionId).toBeUndefined();
    expect(healed.execution?.modelId).toBe('my-pinned-model');
  });

  it('refuses to persist a binding on the Station record at all (delta H3)', async () => {
    // The write boundary, not just the startup heal: a heal that runs once at
    // boot cannot stop the editor round-trip that happens every save.
    const loader = createLoader();
    await registerEngineConnection(loader, 'claude');
    await loader.createAgent({
      slug: 'station',
      name: 'Station',
      prompt: '',
      execution: { agentConnectionId: 'claude', modelId: 'my-pinned-model' },
    } as never);

    const created = await loader.loadAgent('station');
    expect(created.execution).toEqual({ modelId: 'my-pinned-model' });

    await loader.updateAgent('station', {
      execution: { agentConnectionId: 'claude' },
    } as never);
    expect(
      (await loader.loadAgent('station')).execution?.agentConnectionId,
    ).toBeUndefined();
  });

  it('survives a home it cannot write, and says the record stayed stale (review MEDIUM-2)', async () => {
    // A home this process cannot write is a real state, and the heal is a
    // fire-and-forget startup write that simply does not happen there. Before
    // this, that failure aborted native-engine adoption AND left the
    // impossible binding live for the whole session — the original dispatch
    // failure surviving a boot that reported success.
    //
    // The refusal is injected at the WRITE boundary rather than by chmod'ing
    // the agent directory, and that is a finding rather than a convenience:
    // chmod 0o500 on `agents/station` makes `ensureStationHomeSchema` raise
    // STATION_HOME_RESET_REQUIRED, so the registry load fails FIRST and the
    // home is refused wholesale. That is a different (already handled) state
    // and it would not exercise this path at all.
    const loader = createLoader();
    // Registry first: a home that already HAS a Station Agent has necessarily
    // been through this, and creating the Agent without it leaves a home the
    // schema gate refuses wholesale (verified: it fails identically with the
    // real loader, so it is an ordering quirk of the fixture, not this path).
    await loadOrCreateAgentRegistry(loader);
    await seedLegacyStationRecord(loader, { agentConnectionId: 'station' });

    const readOnlyHome = {
      agentExists: (slug: string) => loader.agentExists(slug),
      createAgent: (spec: never) => loader.createAgent(spec),
      loadAgent: (slug: string) => loader.loadAgent(slug),
      listAgents: () => loader.listAgents(),
      getProjectHomeDir: () => loader.getProjectHomeDir(),
      mutateAgent: async () => {
        const error = new Error(
          "EROFS: read-only file system, rename 'agent.json.tmp' -> 'agent.json'",
        ) as Error & { code?: string };
        error.code = 'EROFS';
        throw error;
      },
    } as unknown as ConfigLoader;

    const logger = { info: vi.fn(), warn: vi.fn() };
    const summary = await adoptDetectedNativeEngines({
      configLoader: readOnlyHome,
      logger,
      detect: async () => false,
      delaysMs: [0],
    });

    // Detection is a separate question and still settles honestly.
    expect(summary.outcomes).toEqual({
      claude: 'absent',
      codex: 'absent',
      muse: 'absent',
    });
    // The operator is told the file did not change, and why it still works.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not be rewritten'),
      expect.objectContaining({ error: expect.stringContaining('EROFS') }),
    );
    // The record IS still stale on disk…
    await expect(loader.loadAgent('station')).resolves.toMatchObject({
      execution: { agentConnectionId: 'station' },
    });
    // …and no reader honours it, so dispatch works this boot regardless.
    expect(
      withoutReservedStationBinding(await loader.loadAgent('station'))
        .execution,
    ).toBeUndefined();
  });

  it('does not overwrite an edit that lands while it heals (review HIGH-1)', async () => {
    // The heal runs fire-and-forget AFTER the runtime is serving, so the
    // editor is genuinely concurrent with it. Load-then-save around the lock
    // is a lost update: the heal reads, the user saves a prompt, the heal
    // then writes its stale snapshot back.
    //
    // Deterministic, not timed. The test holds the REAL per-Agent
    // persistence lock, so a heal that reads OUTSIDE it reads now and blocks
    // on the write, while a heal that reads INSIDE it cannot read until the
    // lock is released. The wrapper below signals the unlocked read and then
    // parks it, which is what lets the user's edit land in exactly the window
    // the defect needs.
    const loader = createLoader();
    const home = loader.getProjectHomeDir();
    await seedLegacyStationRecord(loader, {
      agentConnectionId: 'station',
      modelId: 'pinned',
    });

    let signalUnlockedRead: () => void = () => {};
    const unlockedRead = new Promise<void>((resolve) => {
      signalUnlockedRead = resolve;
    });
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const observed = {
      agentExists: (slug: string) => loader.agentExists(slug),
      createAgent: (spec: never) => loader.createAgent(spec),
      mutateAgent: (slug: string, mutate: never) =>
        loader.mutateAgent(slug, mutate),
      // Only a heal that reads outside the lock calls these two; they are
      // present so a regression to that shape RUNS (and loses the edit)
      // rather than dying on a missing method, which would be an injection
      // that reddens for the wrong reason.
      loadAgent: async (slug: string) => {
        const spec = await loader.loadAgent(slug);
        signalUnlockedRead();
        await gate;
        return spec;
      },
      saveAgent: (slug: string, spec: never) => loader.saveAgent(slug, spec),
    } as unknown as ConfigLoader;

    const release = await acquireFileMutationLockAsync(
      join(home, 'config', 'agent-persistence', 'station.lock'),
    );
    const healing = materializeStationAgent(observed);
    // Either the heal has already read (the defect's shape) or it is blocked
    // on the lock and cannot read at all. Both are settled by here.
    await Promise.race([
      unlockedRead,
      new Promise((resolve) => setTimeout(resolve, 150)),
    ]);

    // The user's save, committed to disk while the heal is in flight.
    const edited = JSON.parse(
      readFileSync(join(home, 'agents', 'station', 'agent.json'), 'utf-8'),
    );
    edited.prompt = 'You are the user\u2019s own Station.';
    writeFileSync(
      join(home, 'agents', 'station', 'agent.json'),
      JSON.stringify(edited, null, 2),
    );

    openGate();
    await release();
    expect(await healing).toEqual({ created: false, healed: true });

    const final = await loader.loadAgent('station');
    // The edit survives…
    expect(final.prompt).toBe('You are the user\u2019s own Station.');
    // …and so does the heal, and the unrelated model pin.
    expect(final.execution?.agentConnectionId).toBeUndefined();
    expect(final.execution?.modelId).toBe('pinned');
  });
});
