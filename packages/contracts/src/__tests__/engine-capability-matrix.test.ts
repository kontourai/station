import { describe, expect, test } from 'vitest';
import { engineConnectionId } from '../agent-identity';
import { agentEngineValidationFindings } from '../agent-validation';
import {
  controlPlaneCapableEngineNames,
  ENGINE_CAPABILITY_MATRICES,
  engineControlPlaneCapability,
  resolveBuiltinAgentEngineBinding,
  resolveComposerImageSupport,
  resolveEngineCapabilityMatrix,
  sessionDeliveryChannels,
  UNKNOWN_EXTERNAL_ENGINE_MATRIX,
} from '../engine-capability-matrix';

/**
 * The ACP adapter's declared capabilities, restated here rather than imported:
 * `packages/contracts` is the leaf package every other one imports and must
 * not depend on the station server tree. The station-side test
 * `connection-inspector.test.ts` is what pins the real adapter and the real
 * connection view together; this fixture only has to be a realistic
 * image-capable view for the resolver's own branches.
 */
const ACP_ADAPTER_CAPABILITIES_FIXTURE = [
  'agent-runtime',
  'image-input',
  'session-lifecycle',
  'tool-calls',
  'interrupt',
  'approvals',
  'acp',
] as const;

describe('engine capability matrix', () => {
  test('sessionDeliveryChannels reproduces the shipped per-engine delivery truth (acp/claude/codex; bedrock/ollama undefined)', () => {
    expect(sessionDeliveryChannels('acp')).toEqual({
      toolServers: true,
      skills: false,
      systemPrompt: false,
    });
    expect(sessionDeliveryChannels('claude')).toEqual({
      toolServers: true,
      skills: true,
      systemPrompt: true,
    });
    expect(sessionDeliveryChannels('codex')).toEqual({
      toolServers: true,
      skills: false,
      systemPrompt: false,
    });
    expect(sessionDeliveryChannels('bedrock')).toBeUndefined();
    expect(sessionDeliveryChannels('ollama')).toBeUndefined();
  });

  describe('station#895 wave C: instructionsInFirstTurn (the systemPrompt fallback, never itself labeled systemPrompt)', () => {
    test('shipped only where systemPrompt has no native channel this wave — muse, codex, acp', () => {
      expect(ENGINE_CAPABILITY_MATRICES.muse.instructionsInFirstTurn).toEqual({
        state: 'session',
        channel: 'first-turn',
      });
      expect(ENGINE_CAPABILITY_MATRICES.codex.instructionsInFirstTurn).toEqual({
        state: 'session',
        channel: 'first-turn',
      });
      expect(ENGINE_CAPABILITY_MATRICES.acp.instructionsInFirstTurn).toEqual({
        state: 'session',
        channel: 'first-turn',
      });
    });

    test('unsupported for every engine with its own native systemPrompt channel, and for the unknown-external fallback', () => {
      expect(
        ENGINE_CAPABILITY_MATRICES.station.instructionsInFirstTurn,
      ).toEqual({ state: 'unsupported' });
      expect(ENGINE_CAPABILITY_MATRICES.claude.instructionsInFirstTurn).toEqual(
        { state: 'unsupported' },
      );
      expect(UNKNOWN_EXTERNAL_ENGINE_MATRIX.instructionsInFirstTurn).toEqual({
        state: 'unsupported',
      });
    });

    test('keys every capability matrix by its canonical EngineId', () => {
      for (const [engineId, matrix] of Object.entries(
        ENGINE_CAPABILITY_MATRICES,
      )) {
        expect(matrix.engineId).toBe(engineId);
      }
    });

    test('cross-check: no shipped matrix entry claims both a native systemPrompt AND the first-turn fallback — the fallback is a genuine fallback, never a second channel', () => {
      for (const [provider, matrix] of Object.entries(
        ENGINE_CAPABILITY_MATRICES,
      )) {
        if (matrix.systemPrompt.state === 'session') {
          expect(
            matrix.instructionsInFirstTurn.state,
            `${provider}: systemPrompt is session but instructionsInFirstTurn is also ${matrix.instructionsInFirstTurn.state}`,
          ).not.toBe('session');
        }
      }
      // And every engine has at least ONE of the two channels, or neither —
      // never a matrix entry claiming a first-turn channel while ALSO
      // claiming systemPrompt native (native already covers it).
      for (const matrix of Object.values(ENGINE_CAPABILITY_MATRICES)) {
        if (matrix.systemPrompt.state === 'native') {
          expect(matrix.instructionsInFirstTurn.state).toBe('unsupported');
        }
      }
    });
  });

  test('resolveEngineCapabilityMatrix branch order (engineId, acp, unknown-external)', () => {
    expect(resolveEngineCapabilityMatrix()).toBe(
      ENGINE_CAPABILITY_MATRICES.station,
    );
    expect(resolveEngineCapabilityMatrix('bedrock-runtime')).toBe(
      UNKNOWN_EXTERNAL_ENGINE_MATRIX,
    );
    expect(
      resolveEngineCapabilityMatrix('strands-runtime', {
        config: { engineId: 'station' },
      }),
    ).toBe(ENGINE_CAPABILITY_MATRICES.station);
    expect(resolveEngineCapabilityMatrix('acp')).toBe(
      ENGINE_CAPABILITY_MATRICES.acp,
    );
    expect(
      resolveEngineCapabilityMatrix('kiro-connection', { type: 'acp' }),
    ).toBe(ENGINE_CAPABILITY_MATRICES.acp);
    expect(
      resolveEngineCapabilityMatrix('codex', {
        type: 'codex',
        config: { engineId: 'codex' },
      }),
    ).toBe(ENGINE_CAPABILITY_MATRICES.codex);
    expect(
      resolveEngineCapabilityMatrix('claude', {
        type: 'claude',
        config: { engineId: 'claude' },
      }),
    ).toBe(ENGINE_CAPABILITY_MATRICES.claude);
  });

  test('resolveEngineCapabilityMatrix accepts an engineId-carrying connection (top-level and config-nested), station#1003 Phase B', () => {
    // Top-level engineId (RuntimeConnectionSummary shape).
    expect(
      resolveEngineCapabilityMatrix('bedrock-runtime', {
        engineId: 'station',
      }),
    ).toBe(ENGINE_CAPABILITY_MATRICES.station);
    expect(
      resolveEngineCapabilityMatrix('codex', {
        type: 'codex',
        engineId: 'codex',
      }),
    ).toBe(ENGINE_CAPABILITY_MATRICES.codex);
    // Native adapter projections use the same canonical EngineId throughout.
    expect(
      resolveEngineCapabilityMatrix('codex', {
        type: 'codex',
        config: { engineId: 'codex' },
      }),
    ).toBe(ENGINE_CAPABILITY_MATRICES.codex);
    // A known canonical EngineId is authoritative; connection type is not a
    // second engine identity to reconcile.
    expect(
      resolveEngineCapabilityMatrix('untrusted', {
        type: 'untrusted-runtime',
        config: { engineId: 'codex' },
      }),
    ).toBe(ENGINE_CAPABILITY_MATRICES.codex);
    expect(
      resolveEngineCapabilityMatrix('contradictory-codex', {
        type: 'codex',
        config: { engineId: 'claude' },
      }),
    ).toBe(ENGINE_CAPABILITY_MATRICES.claude);
    expect(
      resolveEngineCapabilityMatrix('contradictory-claude', {
        type: 'claude',
        config: { engineId: 'codex' },
      }),
    ).toBe(ENGINE_CAPABILITY_MATRICES.codex);
    // config-nested engineId (AgentConnectionView/ConnectionConfig shape).
    expect(
      resolveEngineCapabilityMatrix('claude', {
        type: 'claude',
        config: { engineId: 'claude' },
      }),
    ).toBe(ENGINE_CAPABILITY_MATRICES.claude);
    expect(
      resolveEngineCapabilityMatrix('strands-runtime', {
        config: { engineId: 'station' },
      }),
    ).toBe(ENGINE_CAPABILITY_MATRICES.station);
    // acp is still checked before engineId, so a stale engineId can't
    // override the acp identity.
    expect(
      resolveEngineCapabilityMatrix('kiro-connection', {
        type: 'acp',
        engineId: 'station',
      }),
    ).toBe(ENGINE_CAPABILITY_MATRICES.acp);
    // A missing engine identity is no longer upgraded from legacy metadata.
    expect(
      resolveEngineCapabilityMatrix('strands-runtime', {
        config: {},
      }),
    ).toBe(UNKNOWN_EXTERNAL_ENGINE_MATRIX);
    expect(
      resolveEngineCapabilityMatrix('codex', {
        type: 'codex',
        config: { engineId: 'codex' },
      }),
    ).toBe(ENGINE_CAPABILITY_MATRICES.codex);
  });

  test('an acp connection resolves acp regardless of other config (acp is checked first)', () => {
    const staleConnection = {
      type: 'acp',
      config: {},
    };
    expect(
      resolveEngineCapabilityMatrix('kiro-connection', staleConnection),
    ).toBe(ENGINE_CAPABILITY_MATRICES.acp);
  });

  test('an unknown external engine resolves to the all-unsupported conservative matrix, never silently editable surfaces', () => {
    const result = resolveEngineCapabilityMatrix('opencode-connection', {
      type: 'opencode',
      config: {},
    });
    expect(result).toBe(UNKNOWN_EXTERNAL_ENGINE_MATRIX);
    expect(result.systemPrompt).toEqual({ state: 'unsupported' });
    expect(result.toolServers).toEqual({ state: 'unsupported' });
    expect(result.skills).toEqual({ state: 'unsupported' });
    expect(result.commands).toEqual({ state: 'unsupported' });
    expect(result.modelSelection).toEqual({ state: 'unsupported' });
  });

  test('agentEngineValidationFindings names the engine and capability verbatim and returns [] when nothing authored or everything deliverable', () => {
    const codex = ENGINE_CAPABILITY_MATRICES.codex;
    // station#1195: codex's toolServers cell flipped from unsupported to
    // session/wire, so authoring `tools: true` is no longer a validation
    // finding for codex — only prompt/skills/commands remain unsupported.
    expect(
      agentEngineValidationFindings(
        codex,
        { prompt: true, skills: true, tools: true, commands: true },
        'Codex',
      ),
    ).toEqual([
      {
        capability: 'prompt',
        engineId: 'codex',
        message: "Codex can't receive a system prompt from Station",
      },
      {
        capability: 'skills',
        engineId: 'codex',
        message: "Codex can't receive skills from Station",
      },
      {
        capability: 'commands',
        engineId: 'codex',
        message: "Codex can't run Station-defined slash commands",
      },
    ]);
    expect(
      agentEngineValidationFindings(
        codex,
        { prompt: false, skills: false, tools: false, commands: false },
        'Codex',
      ),
    ).toEqual([]);
    expect(
      agentEngineValidationFindings(
        ENGINE_CAPABILITY_MATRICES.station,
        { prompt: true, skills: true, tools: true, commands: true },
        'Station',
      ),
    ).toEqual([]);
  });
});

describe('station#1194: engineControlPlaneCapability (can the engine host station-control?)', () => {
  test('keys on the builtinStationControlDelivery cell the resolver reads — station, claude-code AND codex (#1195) are full; acp (station#1684) is observation-required until its connection is observed', () => {
    // Station: native.
    expect(
      engineControlPlaneCapability(ENGINE_CAPABILITY_MATRICES.station),
    ).toBe('full');
    // Claude Code: session/subprocess with delivery 'env' (#1157).
    expect(
      engineControlPlaneCapability(ENGINE_CAPABILITY_MATRICES.claude),
    ).toBe('full');
    // Codex: session/wire with delivery 'url-token' (#1195) — capable even
    // though its CHANNEL is the same 'wire' as ACP's; the delivery field is
    // what distinguishes them, exactly as in session-agent-resolution.ts.
    expect(engineControlPlaneCapability(ENGINE_CAPABILITY_MATRICES.codex)).toBe(
      'full',
    );
    // ACP: session/wire WITH a delivery mechanism (station#1684), but one
    // whose basis is 'runtime_observation' — so with no observation passed
    // the answer is neither 'full' nor 'chat-only'. It is NOT chat-only:
    // saying no here would be a claim about a connection nobody has met.
    expect(engineControlPlaneCapability(ENGINE_CAPABILITY_MATRICES.acp)).toBe(
      'observation-required',
    );
    // Unknown external engine: unsupported.
    expect(engineControlPlaneCapability(UNKNOWN_EXTERNAL_ENGINE_MATRIX)).toBe(
      'chat-only',
    );
  });

  test('controlPlaneCapableEngineNames() is derived from the same predicate, never a parallel list', () => {
    expect(controlPlaneCapableEngineNames()).toEqual([
      'Station',
      'Claude Code',
      'Codex',
    ]);
    // The derivation, not just today's answer: every name in the list must
    // belong to a matrix entry the predicate calls capable, and every
    // capable entry that can name itself must be in the list. A hardcoded
    // copy string would pass the first assertion above and fail these the
    // moment a cell changed.
    const capable = Object.values(ENGINE_CAPABILITY_MATRICES).filter(
      (matrix) => engineControlPlaneCapability(matrix) === 'full',
    );
    expect(controlPlaneCapableEngineNames().sort()).toEqual(
      capable
        .map((matrix) => matrix.displayName)
        .filter((name): name is string => name !== null)
        .sort(),
    );
    // No capable engine may be nameless: an engine that can run the built-in
    // assistant but cannot say so would silently vanish from the sentence
    // that tells the user what to connect.
    for (const matrix of capable) {
      expect(matrix.displayName).not.toBeNull();
    }
  });

  test('displayName is null exactly where only the live connection can name the engine', () => {
    // A command-backed connection is shown by its own name ("Kiro"), never
    // by the protocol it speaks; the unknown-engine fallback has nothing
    // honest to call itself. Neither derives 'full' from the matrix ALONE
    // (acp is observation-required since station#1684; the unknown fallback
    // is chat-only), so neither can reach controlPlaneCapableEngineNames() —
    // which deliberately passes no observation because it is a statement
    // about engines, not connections.
    expect(ENGINE_CAPABILITY_MATRICES.acp.displayName).toBeNull();
    expect(UNKNOWN_EXTERNAL_ENGINE_MATRIX.displayName).toBeNull();
    expect(ENGINE_CAPABILITY_MATRICES.station.displayName).toBe('Station');
    expect(ENGINE_CAPABILITY_MATRICES.claude.displayName).toBe('Claude Code');
    expect(ENGINE_CAPABILITY_MATRICES.codex.displayName).toBe('Codex');
  });

  test('a session channel WITHOUT a delivery mechanism is chat-only regardless of channel name — proves this keys on the delivery field, not a channel or engine list', () => {
    expect(
      engineControlPlaneCapability({
        toolServers: { state: 'session', channel: 'app-home' },
      }),
    ).toBe('chat-only');
    // Even 'subprocess' without a declared delivery mechanism is chat-only:
    // the field the resolver exempts on is the truth, the channel is not.
    expect(
      engineControlPlaneCapability({
        toolServers: { state: 'session', channel: 'subprocess' },
      }),
    ).toBe('chat-only');
    // And ANY channel WITH one is full.
    expect(
      engineControlPlaneCapability({
        toolServers: {
          state: 'session',
          channel: 'app-home',
          builtinStationControlDelivery: {
            mechanism: 'url-token',
            basis: 'declared',
          },
        },
      }),
    ).toBe('full');
  });
});

describe('station#1684: the SHIPPED acp cell derives all three states', () => {
  const observedAt = '2026-08-03T00:00:00.000Z';

  test('the cell itself names the mechanism, the basis, and the evidence it requires', () => {
    const cell = ENGINE_CAPABILITY_MATRICES.acp.toolServers;
    expect(cell.state).toBe('session');
    expect(
      cell.state === 'session' ? cell.builtinStationControlDelivery : null,
    ).toEqual({
      mechanism: 'http-header-token',
      basis: 'runtime_observation',
      observation: 'acp-mcp-http',
    });
  });

  test('no observation ⇒ observation-required (never met this connection)', () => {
    expect(engineControlPlaneCapability(ENGINE_CAPABILITY_MATRICES.acp)).toBe(
      'observation-required',
    );
  });

  test('observed mcpHttp: true ⇒ full', () => {
    expect(
      engineControlPlaneCapability(ENGINE_CAPABILITY_MATRICES.acp, {
        mcpHttp: true,
        observedAt,
      }),
    ).toBe('full');
  });

  test('observed mcpHttp: false ⇒ chat-only (this CLI said no, which is a different fact from never asking)', () => {
    expect(
      engineControlPlaneCapability(ENGINE_CAPABILITY_MATRICES.acp, {
        mcpHttp: false,
        observedAt,
      }),
    ).toBe('chat-only');
    // ...and the three answers are genuinely three, not two plus an alias.
    expect(
      new Set([
        engineControlPlaneCapability(ENGINE_CAPABILITY_MATRICES.acp),
        engineControlPlaneCapability(ENGINE_CAPABILITY_MATRICES.acp, {
          mcpHttp: true,
          observedAt,
        }),
        engineControlPlaneCapability(ENGINE_CAPABILITY_MATRICES.acp, {
          mcpHttp: false,
          observedAt,
        }),
      ]).size,
    ).toBe(3);
  });

  test('an observation does NOT move a declared cell — codex ignores it entirely', () => {
    // Guards the inverse mistake: a per-connection observation must not be
    // able to downgrade an engine whose mechanism is statically true.
    expect(
      engineControlPlaneCapability(ENGINE_CAPABILITY_MATRICES.codex, {
        mcpHttp: false,
        observedAt,
      }),
    ).toBe('full');
  });
});

describe('station#1549: the observation-based basis (policy in the cell, evidence on the connection)', () => {
  const observationCell = {
    toolServers: {
      state: 'session',
      channel: 'wire',
      builtinStationControlDelivery: {
        mechanism: 'http-header-token',
        basis: 'runtime_observation',
        observation: 'acp-mcp-http',
      },
    },
  } as const;

  test('a runtime_observation cell derives all THREE states from the same static cell — the third state lives in the codomain, not the matrix', () => {
    // Never observed: not a no (Station has never met this subject) and not
    // a yes (Station cannot know). Its own state.
    expect(engineControlPlaneCapability(observationCell)).toBe(
      'observation-required',
    );
    // Observed yes.
    expect(
      engineControlPlaneCapability(observationCell, {
        mcpHttp: true,
        observedAt: '2026-08-02T00:00:00.000Z',
      }),
    ).toBe('full');
    // Observed no — plain chat-only, the same answer (and therefore the same
    // shipped #1283 copy) as an engine with no mechanism at all.
    expect(
      engineControlPlaneCapability(observationCell, {
        mcpHttp: false,
        observedAt: '2026-08-02T00:00:00.000Z',
      }),
    ).toBe('chat-only');
  });

  test('a declared basis IGNORES the observation entirely — Claude and Codex are byte-identical with or without one', () => {
    for (const matrix of [
      ENGINE_CAPABILITY_MATRICES.claude,
      ENGINE_CAPABILITY_MATRICES.codex,
      ENGINE_CAPABILITY_MATRICES.station,
    ]) {
      const withoutObservation = engineControlPlaneCapability(matrix);
      expect(withoutObservation).toBe('full');
      // Even an observation that says NO cannot demote a declared cell: the
      // mechanism's correctness is a reviewed property of the engine class,
      // not something an ACP handshake has any authority over.
      expect(
        engineControlPlaneCapability(matrix, {
          mcpHttp: false,
          observedAt: '2026-08-02T00:00:00.000Z',
        }),
      ).toBe(withoutObservation);
    }
    // And the converse: an observation cannot PROMOTE a cell with no
    // mechanism at all. Evidence is the second half of a derivation whose
    // first half is a reviewed mechanism; on its own it decides nothing.
    // (station#1684 moved this assertion off ENGINE_CAPABILITY_MATRICES.acp,
    // which now names a mechanism, and onto a synthetic mechanism-less cell —
    // the property under test was never about ACP specifically.)
    expect(
      engineControlPlaneCapability(
        { toolServers: { state: 'session', channel: 'wire' } },
        { mcpHttp: true, observedAt: '2026-08-02T00:00:00.000Z' },
      ),
    ).toBe('chat-only');
  });

  test('station#1684: EXACTLY ONE shipped cell carries an observation basis, and it is acp', () => {
    // Slice 1's version of this test asserted that EVERY shipped cell was
    // `declared` — its way of pinning "this slice adds a type and changes no
    // behavior". Slice 2 is the change it was holding the door for, so the
    // successor pins the new fact rather than deleting the guard: an
    // observation basis makes a production surface start consulting
    // evidence, so a cell acquiring one must be a deliberate, reviewed act,
    // not a copy-paste from the entry above it.
    const observationBased: string[] = [];
    for (const [provider, matrix] of Object.entries(
      ENGINE_CAPABILITY_MATRICES,
    )) {
      const cell = matrix.toolServers;
      if (cell.state !== 'session') continue;
      const delivery = cell.builtinStationControlDelivery;
      if (delivery === undefined) continue;
      if (delivery.basis === 'runtime_observation') {
        observationBased.push(provider);
      } else {
        expect(delivery.basis).toBe('declared');
      }
    }
    expect(observationBased).toEqual(['acp']);
  });

  test('resolveBuiltinAgentEngineBinding never optimistically binds an unobserved connection, and binds it the moment evidence says yes', () => {
    const unobserved = {
      connectionId: engineConnectionId('acp-kiro'),
      matrix: {
        ...ENGINE_CAPABILITY_MATRICES.acp,
        ...observationCell,
      },
    };
    // Explicit saved choice + no evidence ⇒ fails safe to Station for THIS
    // resolution; the persisted choice itself is untouched (the caller's
    // input is not mutated).
    expect(
      resolveBuiltinAgentEngineBinding({
        explicitConnectionId: engineConnectionId('acp-kiro'),
        stationChatReady: false,
        readyExternalEngines: [unobserved],
      }),
    ).toBeNull();
    // The unchosen sensible-default branch must not pick it either — a
    // machine whose only ready engine is unobserved resolves to Station.
    expect(
      resolveBuiltinAgentEngineBinding({
        explicitConnectionId: undefined,
        stationChatReady: false,
        readyExternalEngines: [unobserved],
      }),
    ).toBeNull();

    // Evidence arrives on the SAME connection record: the identical
    // persisted choice now resolves, with no user action and no code change.
    const observed = {
      ...unobserved,
      controlPlaneObservation: {
        mcpHttp: true,
        observedAt: '2026-08-02T00:00:00.000Z',
      },
    };
    expect(
      resolveBuiltinAgentEngineBinding({
        explicitConnectionId: engineConnectionId('acp-kiro'),
        stationChatReady: false,
        readyExternalEngines: [observed],
      }),
    ).toEqual(observed);

    // Evidence that says no is a real answer and stays unbound.
    expect(
      resolveBuiltinAgentEngineBinding({
        explicitConnectionId: engineConnectionId('acp-kiro'),
        stationChatReady: false,
        readyExternalEngines: [
          {
            ...unobserved,
            controlPlaneObservation: {
              mcpHttp: false,
              observedAt: '2026-08-02T00:00:00.000Z',
            },
          },
        ],
      }),
    ).toBeNull();
  });

  test('controlPlaneCapableEngineNames() omits an observation-based engine class — the sentence is about engines, and this answer is per-connection', () => {
    // Guards the real surface: the sentence today must not change, and if
    // slice 2's cell flip ever silently added a name to it, this fails.
    expect(controlPlaneCapableEngineNames()).toEqual([
      'Station',
      'Claude Code',
      'Codex',
    ]);
    expect(engineControlPlaneCapability(observationCell)).not.toBe('full');
  });
});

describe('station#1194: resolveBuiltinAgentEngineBinding (rebind + default-selection logic)', () => {
  const claudeEngine = {
    connectionId: engineConnectionId('claude'),
    matrix: ENGINE_CAPABILITY_MATRICES.claude,
  };
  const codexEngine = {
    connectionId: engineConnectionId('codex'),
    matrix: ENGINE_CAPABILITY_MATRICES.codex,
  };
  // The chat-only engine of record since #1195 made codex capable: ACP's
  // bare wire channel has no builtinStationControlDelivery mechanism.
  const acpEngine = {
    connectionId: engineConnectionId('acp-kiro'),
    matrix: ENGINE_CAPABILITY_MATRICES.acp,
  };

  test('AC3 default: Station wins when its own model is chat-ready, regardless of ready external engines', () => {
    expect(
      resolveBuiltinAgentEngineBinding({
        explicitConnectionId: undefined,
        stationChatReady: true,
        readyExternalEngines: [claudeEngine, codexEngine],
      }),
    ).toBeNull();
  });

  test('AC3 default: the single ready CAPABLE external engine wins when Station has no chat-ready model', () => {
    expect(
      resolveBuiltinAgentEngineBinding({
        explicitConnectionId: undefined,
        stationChatReady: false,
        readyExternalEngines: [claudeEngine],
      }),
    ).toEqual(claudeEngine);
  });

  test('owner directive (offer only capable engines): a single ready chat-only engine is NEVER auto-bound — an ACP-only machine resolves to null, not a decorative assistant', () => {
    // ACP's matrix has no builtinStationControlDelivery, so the helper's
    // station-control server cannot be delivered to it. Auto-binding it
    // would register an assistant that responds and cannot do the one thing
    // it exists for.
    expect(
      resolveBuiltinAgentEngineBinding({
        explicitConnectionId: undefined,
        stationChatReady: false,
        readyExternalEngines: [acpEngine],
      }),
    ).toBeNull();
  });

  test('owner directive: a single ready CODEX engine auto-binds — #1195 made it capable, and this is derived from its cell, not a list', () => {
    expect(
      resolveBuiltinAgentEngineBinding({
        explicitConnectionId: undefined,
        stationChatReady: false,
        readyExternalEngines: [codexEngine],
      }),
    ).toEqual(codexEngine);
  });

  test('owner directive: capability also disambiguates — one capable among several ready engines auto-binds the capable one', () => {
    // Pre-filter this is the "2+ ready engines is ambiguous" case; keyed off
    // capability it is not ambiguous at all, because only one of them can
    // actually power the helper.
    expect(
      resolveBuiltinAgentEngineBinding({
        explicitConnectionId: undefined,
        stationChatReady: false,
        readyExternalEngines: [claudeEngine, acpEngine],
      }),
    ).toEqual(claudeEngine);
  });

  test('AC3 default: ambiguous (0 or 2+ ready CAPABLE external engines, no Station model) safely defaults to Station', () => {
    expect(
      resolveBuiltinAgentEngineBinding({
        explicitConnectionId: undefined,
        stationChatReady: false,
        readyExternalEngines: [],
      }),
    ).toBeNull();
    // Two capable engines (e.g. two Claude Code connections) IS genuinely
    // ambiguous — guessing between them would choose for the user.
    const secondClaudeEngine = {
      connectionId: engineConnectionId('claude-2'),
      matrix: ENGINE_CAPABILITY_MATRICES.claude,
    };
    expect(
      resolveBuiltinAgentEngineBinding({
        explicitConnectionId: undefined,
        stationChatReady: false,
        readyExternalEngines: [claudeEngine, secondClaudeEngine],
      }),
    ).toBeNull();
  });

  test('AC2 idempotent/no-clobber: an explicit external choice is sticky even once Station becomes chat-ready', () => {
    expect(
      resolveBuiltinAgentEngineBinding({
        explicitConnectionId: engineConnectionId('claude'),
        stationChatReady: true,
        readyExternalEngines: [claudeEngine],
      }),
    ).toEqual(claudeEngine);
  });

  test('owner directive: an explicit choice of a chat-only engine fails safe to Station for THIS resolution — and starts resolving the moment the cell gains a delivery mechanism', () => {
    // The persisted choice is input, never mutated here — same contract as
    // the dangling-id case. A config naming an ACP connection resolves to
    // Station rather than a decorative assistant…
    expect(
      resolveBuiltinAgentEngineBinding({
        explicitConnectionId: engineConnectionId('acp-kiro'),
        stationChatReady: false,
        readyExternalEngines: [acpEngine],
      }),
    ).toBeNull();
    // …and this is keyed off the capability CELL, not the engine name: the
    // same connection whose cell gains a builtinStationControlDelivery
    // mechanism (exactly how codex went from excluded to offered when
    // #1195 shipped 'url-token') resolves immediately, with no user action
    // and no code change here.
    const capableAcpEngine = {
      connectionId: engineConnectionId('acp-kiro'),
      matrix: {
        ...ENGINE_CAPABILITY_MATRICES.acp,
        toolServers: {
          state: 'session',
          channel: 'wire',
          builtinStationControlDelivery: {
            mechanism: 'url-token',
            basis: 'declared',
          },
        } as const,
      },
    };
    expect(
      resolveBuiltinAgentEngineBinding({
        explicitConnectionId: engineConnectionId('acp-kiro'),
        stationChatReady: false,
        readyExternalEngines: [capableAcpEngine],
      }),
    ).toEqual(capableAcpEngine);
  });

  test('AC2 idempotent/no-clobber: an explicit Station choice (null) is sticky even when an external engine is ready', () => {
    expect(
      resolveBuiltinAgentEngineBinding({
        explicitConnectionId: null,
        stationChatReady: false,
        readyExternalEngines: [claudeEngine],
      }),
    ).toBeNull();
  });

  test('re-running with the same explicit input is deterministic (idempotent) — repeated calls never drift', () => {
    const input = {
      explicitConnectionId: engineConnectionId('claude'),
      stationChatReady: true,
      readyExternalEngines: [claudeEngine],
    };
    const first = resolveBuiltinAgentEngineBinding(input);
    const second = resolveBuiltinAgentEngineBinding(input);
    expect(first).toEqual(claudeEngine);
    expect(second).toEqual(first);
  });

  test('an explicit choice that no longer resolves to a ready external engine fails safe to Station (never binds to a dangling id)', () => {
    expect(
      resolveBuiltinAgentEngineBinding({
        explicitConnectionId: engineConnectionId('claude'),
        stationChatReady: false,
        readyExternalEngines: [],
      }),
    ).toBeNull();
  });
});

describe('built-in engines resolve to their own matrix (#2301)', () => {
  const projected = (engineId: string) => ({
    type: engineId,
    config: { engineId },
  });

  test.each(['claude', 'codex', 'muse'])(
    '%s resolves to its own matrix, not the unknown fallback',
    (engineId) => {
      const result = resolveEngineCapabilityMatrix(
        engineId,
        projected(engineId),
      );
      expect(result).toBe(ENGINE_CAPABILITY_MATRICES[engineId]);
      expect(result).not.toBe(UNKNOWN_EXTERNAL_ENGINE_MATRIX);
    },
  );

  test('a genuinely unknown engineId still falls back, rather than inventing a matrix', () => {
    const result = resolveEngineCapabilityMatrix('mystery', {
      type: 'mystery-runtime',
      config: { engineId: 'mystery' },
    });
    expect(result).toBe(UNKNOWN_EXTERNAL_ENGINE_MATRIX);
  });
});

describe('resolveComposerImageSupport (station#3344)', () => {
  test('an engine whose cell declares no image path refuses with the cell reason', () => {
    expect(
      resolveComposerImageSupport(ENGINE_CAPABILITY_MATRICES.muse),
    ).toEqual({
      attachable: false,
      refusal: 'Muse Code runs a text-only prompt and cannot see images.',
    });
    expect(
      resolveComposerImageSupport(UNKNOWN_EXTERNAL_ENGINE_MATRIX).attachable,
    ).toBe(false);
  });

  test('the Station engine attaches with no connection record at all', () => {
    expect(
      resolveComposerImageSupport(ENGINE_CAPABILITY_MATRICES.station),
    ).toEqual({ attachable: true });
  });

  // Review HIGH-1: `connection-inspector.ts` hand-builds the ACP connection
  // view, and its capability literal had lost `image-input` while the adapter
  // declared it. Because a present `connectionCapabilities` outranks the cell,
  // that one omission refused every ACP image. This is the resolver-level
  // statement of that defect, so re-introducing it upstream reds here too.
  test('a connection view missing image-input refuses even when the cell declares one', () => {
    expect(
      resolveComposerImageSupport(ENGINE_CAPABILITY_MATRICES.acp, {
        connectionCapabilities: [
          'agent-runtime',
          'session-lifecycle',
          'tool-calls',
          'interrupt',
          'approvals',
          'acp',
        ],
      }),
    ).toEqual({
      attachable: false,
      refusal: 'This engine cannot see images.',
    });
    expect(
      resolveComposerImageSupport(ENGINE_CAPABILITY_MATRICES.acp, {
        connectionCapabilities: [...ACP_ADAPTER_CAPABILITIES_FIXTURE],
      }),
    ).toEqual({ attachable: true });
  });

  describe('a runtime_observation cell reads the live handshake', () => {
    const acpConnection = {
      connectionCapabilities: [...ACP_ADAPTER_CAPABILITIES_FIXTURE],
      connectionLabel: 'Kiro',
    };

    test('observed true attaches', () => {
      expect(
        resolveComposerImageSupport(ENGINE_CAPABILITY_MATRICES.acp, {
          ...acpConnection,
          observedImagePrompt: true,
        }),
      ).toEqual({ attachable: true });
    });

    test('observed false refuses, naming the connected engine', () => {
      expect(
        resolveComposerImageSupport(ENGINE_CAPABILITY_MATRICES.acp, {
          ...acpConnection,
          observedImagePrompt: false,
        }),
      ).toEqual({
        attachable: false,
        refusal: 'Kiro reported that it cannot accept images.',
      });
    });

    test('unobserved attaches — a handshake nobody has run is not a refusal', () => {
      expect(
        resolveComposerImageSupport(
          ENGINE_CAPABILITY_MATRICES.acp,
          acpConnection,
        ),
      ).toEqual({ attachable: true });
    });

    test('an observation is ignored by an engine whose cell is `declared`', () => {
      // Claude's image path is a permanent property of the engine class; no
      // handshake speaks for it, so a stray field must not refuse it.
      expect(
        resolveComposerImageSupport(ENGINE_CAPABILITY_MATRICES.claude, {
          observedImagePrompt: false,
        }),
      ).toEqual({ attachable: true });
    });
  });

  test('a model the catalog reports image-blind outranks a capable engine', () => {
    expect(
      resolveComposerImageSupport(ENGINE_CAPABILITY_MATRICES.station, {
        modelSupport: 'no',
        modelLabel: 'text-only-model',
      }),
    ).toEqual({
      attachable: false,
      refusal:
        'text-only-model cannot see images. Pick a model that accepts image input.',
    });
    for (const modelSupport of ['yes', 'unknown'] as const) {
      expect(
        resolveComposerImageSupport(ENGINE_CAPABILITY_MATRICES.station, {
          modelSupport,
        }),
      ).toEqual({ attachable: true });
    }
  });

  // The collapse removed the branches that read the deprecated executionClass.
  // These pin what stored connections resolve to now, so the removal is an
  // asserted decision rather than an uncovered one: main asserted this field 12
  // times and the collapse left it asserted nowhere.
  test('legacy executionClass connections resolve without borrowing Station', () => {
    // 'managed' is Station running the agent, which is the default anyway.
    expect(
      resolveEngineCapabilityMatrix(undefined, {
        config: { executionClass: 'managed' },
      } as never),
    ).toBe(ENGINE_CAPABILITY_MATRICES.station);

    // 'connected' names an external engine. Without the read-compat below it
    // reached the final `station` return and reported Station's capabilities
    // for an engine Station does not run.
    expect(
      resolveEngineCapabilityMatrix(undefined, {
        type: 'claude-code',
        config: { executionClass: 'connected' },
      } as never),
    ).not.toBe(ENGINE_CAPABILITY_MATRICES.station);

    // An unrecognised type stays unknown-external rather than falling back.
    expect(
      resolveEngineCapabilityMatrix(undefined, {
        type: 'not-a-known-engine',
        config: { executionClass: 'connected' },
      } as never),
    ).toBe(UNKNOWN_EXTERNAL_ENGINE_MATRIX);
  });
});
