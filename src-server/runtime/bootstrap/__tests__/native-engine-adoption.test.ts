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
  adoptDetectedNativeEngines,
  NATIVE_ENGINE_CANDIDATES,
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
 * A `station` record as an OLDER build left it — carrying an engine binding.
 *
 * It has to be written to disk directly: since station#3662 delta H3 the
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
    // The engine's OWN record: same source AND the same runtime id the
    // candidate table declares. Both halves matter — a mismatch on either is
    // a genuine collision, which is what the sibling test below covers.
    const [claudeCandidate] = NATIVE_ENGINE_CANDIDATES.filter(
      (candidate) => candidate.id === 'claude',
    );
    await registerEngineConnection(
      loader,
      claudeCandidate.id,
      claudeCandidate.runtimeConnectionId,
      { kind: 'native' },
    );

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

  it('a native id bound to a DIFFERENT runtime is a collision, not this engine', async () => {
    // Same source, different adapter. Treating it as "exists" would point the
    // engine's Agent at a runtime the detected CLI does not drive.
    const loader = createLoader();
    await registerEngineConnection(loader, 'claude', 'some-other-runtime', {
      kind: 'native',
    });

    const summary = await adoptDetectedNativeEngines({
      configLoader: loader,
      logger: silentLogger,
      detect: async () => true,
      delaysMs: [0],
    });

    expect(summary.outcomes.claude).toBe('connection-collision');
    const agents = await loader.listAgents();
    expect(agents.some((agent) => agent.slug === 'claude')).toBe(false);
  });

  it('never brands a foreign connection sharing a native id as that engine', async () => {
    // A user's own ACP command registered as `claude`. Detection then finds
    // the real Claude CLI on PATH. The id is taken by something else, so the
    // registration collides — and folding that collision into 'exists' had
    // bootstrap materialize an Agent named "Claude Code" bound to the
    // stranger's engine.
    const loader = createLoader();
    await registerEngineConnection(loader, 'claude', 'my-own-acp', {
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
    // All-absent detection: attempt 1 does zero registry I/O, so the run is
    // deterministically INSIDE the 600s delay when the abort lands — a
    // broken abort listener cannot hide behind the outer loop guard (the
    // #1575 verifier proved the previous shape never reached the listener).
    const detect = vi.fn(async () => false);

    const startedAt = Date.now();
    const pending = adoptDetectedNativeEngines({
      configLoader: loader,
      logger: silentLogger,
      detect,
      // Without a working in-delay abort this settles only after ~10 minutes.
      delaysMs: [0, 600_000],
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    const summary = await pending;
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(summary.outcomes).toEqual({
      claude: 'absent',
      codex: 'absent',
      muse: 'absent',
    });
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
  it('adopts muse under its engine id, bound to the muse runtime connection', () => {
    // Pinned explicitly: the outcome-map assertions above would still pass if
    // muse were adopted under the wrong id or bound to another runtime.
    const muse = NATIVE_ENGINE_CANDIDATES.find(
      (candidate) => candidate.id === 'muse',
    );
    expect(muse).toEqual({
      id: 'muse',
      runtimeConnectionId: 'muse-runtime',
      cli: 'muse',
    });
  });

  it('binds every candidate to a distinct id, cli and runtime connection', () => {
    const ids = NATIVE_ENGINE_CANDIDATES.map((c) => c.id);
    const clis = NATIVE_ENGINE_CANDIDATES.map((c) => c.cli);
    const runtimes = NATIVE_ENGINE_CANDIDATES.map((c) => c.runtimeConnectionId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(clis).size).toBe(clis.length);
    expect(new Set(runtimes).size).toBe(runtimes.length);
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
    await registerEngineConnection(loader, 'claude', 'claude-runtime');
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
    await registerEngineConnection(loader, 'claude', 'claude-runtime');
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
