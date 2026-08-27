import { describe, expect, test } from 'vitest';
import {
  acceptModelLaunchPlan,
  MODEL_OPTION_UNRESTRICTED_PROVIDERS,
  modelLaunchTelemetryAttributes,
  PROVIDER_MODEL_OPTION_SUPPORT,
  RESERVED_ORCHESTRATION_METADATA_KEYS,
  resolveModelLaunchPlan,
  stripReservedOrchestrationMetadata,
  unsupportedModelOptionError,
  unsupportedModelOptionKeys,
} from '../provider.js';

describe('ModelLaunchPlan', () => {
  const engineSelected = {
    defaultAtStart: 'engine-selected' as const,
    omissionAtResume: 'engine-selected' as const,
    omissionPerTurn: 'engine-selected' as const,
    overrideAtStart: true,
    overrideAtResume: true,
    overridePerTurn: true,
  };

  test('has exactly station-resolved, engine-selected, and unavailable outcomes', () => {
    expect(
      resolveModelLaunchPlan(
        {
          ...engineSelected,
          modelConnectionId: 'ollama-runtime',
          defaultAtStart: 'station-resolved',
        },
        { lifecycle: 'start', requestedModelId: 'llama3.2' },
      ),
    ).toEqual({
      kind: 'station-resolved',
      modelConnectionId: 'ollama-runtime',
      modelId: 'llama3.2',
      evidence: 'catalog-pending',
    });
    expect(
      resolveModelLaunchPlan(engineSelected, { lifecycle: 'start' }),
    ).toEqual({ kind: 'engine-selected', evidence: 'adapter-declared' });
    expect(resolveModelLaunchPlan(undefined, { lifecycle: 'start' })).toEqual({
      kind: 'engine-selected',
      evidence: 'capability-absent',
    });
  });

  test('retains an already accepted Station selector on resume and turn omission', () => {
    const stationResolved = {
      defaultAtStart: 'station-resolved' as const,
      omissionAtResume: 'retain-session-model' as const,
      omissionPerTurn: 'retain-session-model' as const,
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
      modelConnectionId: 'ollama-runtime',
    };
    expect(
      resolveModelLaunchPlan(stationResolved, {
        lifecycle: 'turn',
        retainedModelId: 'llama3.2',
      }),
    ).toEqual({
      kind: 'station-resolved',
      modelConnectionId: 'ollama-runtime',
      modelId: 'llama3.2',
      evidence: 'catalog-pending',
    });
    expect(
      resolveModelLaunchPlan(stationResolved, { lifecycle: 'resume' }),
    ).toEqual({ kind: 'unavailable', reason: 'model-required' });
  });

  test('records adapter-owned retention without fabricating a Station model connection', () => {
    const adapterRetained = {
      defaultAtStart: 'engine-selected' as const,
      omissionAtResume: 'retain-session-model' as const,
      omissionPerTurn: 'retain-session-model' as const,
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
    };

    expect(
      resolveModelLaunchPlan(adapterRetained, {
        lifecycle: 'turn',
        retainedModelId: 'inner-engine-selector',
      }),
    ).toEqual({ kind: 'engine-selected', evidence: 'adapter-retained' });
  });

  // station#1995 regression: an engine-selected start records no session
  // model, so the first turn (and any resume) arrives with nothing to
  // retain. The engine that was allowed to pick the model at start must be
  // allowed to pick it again — the old fail-closed 'model-required' made a
  // Station-engine session started without an override unable to take a
  // single turn.
  test('defers to the engine when nothing was retained and the start was engine-selected', () => {
    const adapterRetained = {
      defaultAtStart: 'engine-selected' as const,
      omissionAtResume: 'retain-session-model' as const,
      omissionPerTurn: 'retain-session-model' as const,
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
    };
    expect(
      resolveModelLaunchPlan(adapterRetained, { lifecycle: 'turn' }),
    ).toEqual({ kind: 'engine-selected', evidence: 'adapter-declared' });
    expect(
      resolveModelLaunchPlan(adapterRetained, { lifecycle: 'resume' }),
    ).toEqual({ kind: 'engine-selected', evidence: 'adapter-declared' });
    // Station-resolved adapters genuinely need a model: still fail closed.
    expect(
      resolveModelLaunchPlan(
        {
          ...adapterRetained,
          defaultAtStart: 'station-resolved' as const,
          modelConnectionId: 'ollama-runtime',
        },
        { lifecycle: 'turn' },
      ),
    ).toEqual({ kind: 'unavailable', reason: 'model-required' });
  });

  test('does not mint catalog acceptance until the validating adapter records it', () => {
    const pending = resolveModelLaunchPlan(
      {
        defaultAtStart: 'station-resolved',
        omissionAtResume: 'retain-session-model',
        omissionPerTurn: 'retain-session-model',
        overrideAtStart: true,
        overrideAtResume: true,
        overridePerTurn: true,
        modelConnectionId: 'bedrock-runtime',
      },
      { lifecycle: 'start', requestedModelId: 'profile-alias' },
    );
    expect(pending).toMatchObject({ evidence: 'catalog-pending' });
    expect(
      acceptModelLaunchPlan(pending, { modelId: 'resolved-profile' }),
    ).toEqual({
      kind: 'station-resolved',
      modelConnectionId: 'bedrock-runtime',
      modelId: 'resolved-profile',
      evidence: 'catalog-accepted',
    });
  });

  test('keeps Codex omission engine-selected and ACP overrides unavailable', () => {
    expect(
      resolveModelLaunchPlan(engineSelected, { lifecycle: 'start' }),
    ).toEqual({ kind: 'engine-selected', evidence: 'adapter-declared' });
    expect(
      resolveModelLaunchPlan(
        {
          defaultAtStart: 'engine-selected',
          omissionAtResume: 'engine-selected',
          omissionPerTurn: 'engine-selected',
          overrideAtStart: false,
          overrideAtResume: false,
          overridePerTurn: false,
        },
        { lifecycle: 'turn', requestedModelId: 'never-applied' },
      ),
    ).toEqual({ kind: 'unavailable', reason: 'turn-override-unsupported' });
  });

  test('treats an engine-confirmed model restatement as retention', () => {
    const sessionScoped = {
      defaultAtStart: 'engine-selected' as const,
      omissionAtResume: 'retain-session-model' as const,
      omissionPerTurn: 'retain-session-model' as const,
      overrideAtStart: true,
      overrideAtResume: false,
      overridePerTurn: false,
    };
    expect(
      resolveModelLaunchPlan(sessionScoped, {
        lifecycle: 'turn',
        requestedModelId: 'zai/glm',
        retainedModelId: 'zai/glm',
      }),
    ).toEqual({ kind: 'engine-selected', evidence: 'adapter-retained' });
    expect(
      resolveModelLaunchPlan(sessionScoped, {
        lifecycle: 'turn',
        requestedModelId: 'other/model',
        retainedModelId: 'zai/glm',
      }),
    ).toEqual({ kind: 'unavailable', reason: 'turn-override-unsupported' });
  });

  test('projects only bounded, content-free telemetry attributes', () => {
    expect(
      modelLaunchTelemetryAttributes(
        'untrusted-plugin-provider',
        'turn',
        true,
        { kind: 'unavailable', reason: 'turn-override-unsupported' },
      ),
    ).toEqual({
      provider: 'other',
      lifecycle: 'turn',
      requested_override: 'true',
      plan: 'unavailable',
      outcome: 'rejected',
      reason: 'turn-override-unsupported',
    });
  });
});

test('strips every server-derived model evidence key while preserving ordinary options', () => {
  const metadata = Object.fromEntries(
    RESERVED_ORCHESTRATION_METADATA_KEYS.map((key) => [key, 'forged']),
  );
  expect(
    stripReservedOrchestrationMetadata({ ...metadata, effort: 'low' }),
  ).toEqual({
    effort: 'low',
  });
});

/**
 * station#978 — `PROVIDER_MODEL_OPTION_SUPPORT` is derived from each
 * adapter's own `modelOptions` reads (cited in `provider.ts`'s docblock):
 * - claude (`src-server/providers/adapters/claude-adapter.ts`):
 *   `resolvePermissionMode` reads `approvalMode`; `claudeAppliedModelOptions`
 *   reads `effort`/`thinking`/`fastMode`/`autoMode`, all diffed and applied
 *   via `query.applyFlagSettings()` (~lines 90-107, 548-583).
 * - codex (`src-server/providers/adapters/codex-adapter.ts` +
 *   `codex-approval-mode.ts`): `resolveCodexApprovalKnobs` reads
 *   `approvalMode`; `mapReasoningEffort` reads `effort` falling back to
 *   `reasoningEffort` (~line 71); `fastMode` is read directly (~lines
 *   555-633).
 * - acp (`src-server/providers/adapters/acp-adapter.ts`): reads
 *   `modelOptions` only twice (~lines 579, 650), both times purely to echo
 *   the bag into a display-only `effectiveModelMetadata(...)` snapshot — no
 *   key is applied to session/turn behavior, so the support list is empty.
 * - ollama/bedrock: read only `modelOptions.systemPrompt` — out of
 *   station#978's scope, so it is NOT added to either support list; a
 *   caller-supplied `systemPrompt` is rejected as unsupported for every
 *   provider (review r1 HIGH fix).
 */
describe('PROVIDER_MODEL_OPTION_SUPPORT', () => {
  test('claude supports approvalMode, effort, thinking, fastMode, and autoMode', () => {
    expect(PROVIDER_MODEL_OPTION_SUPPORT.claude).toEqual([
      'approvalMode',
      'effort',
      'thinking',
      'fastMode',
      'autoMode',
    ]);
  });

  test('codex supports approvalMode, effort (and its reasoningEffort alias), and fastMode', () => {
    expect(PROVIDER_MODEL_OPTION_SUPPORT.codex).toEqual([
      'approvalMode',
      'effort',
      'reasoningEffort',
      'fastMode',
    ]);
  });

  test('acp, ollama, and bedrock support no modelOptions keys today', () => {
    expect(PROVIDER_MODEL_OPTION_SUPPORT.acp).toEqual([]);
    expect(PROVIDER_MODEL_OPTION_SUPPORT.ollama).toEqual([]);
    expect(PROVIDER_MODEL_OPTION_SUPPORT.bedrock).toEqual([]);
  });
});

describe('unsupportedModelOptionKeys', () => {
  test('returns an empty array when modelOptions is absent', () => {
    expect(unsupportedModelOptionKeys('claude')).toEqual([]);
  });

  test('returns an empty array when every key is supported', () => {
    expect(
      unsupportedModelOptionKeys('claude', {
        approvalMode: 'auto',
        effort: 'high',
      }),
    ).toEqual([]);
  });

  test('names every key the target provider does not read', () => {
    expect(
      unsupportedModelOptionKeys('codex', {
        approvalMode: 'auto',
        thinking: true,
      }),
    ).toEqual(['thinking']);
  });

  test('flags every key for a provider with an explicit empty support list (acp)', () => {
    expect(unsupportedModelOptionKeys('acp', { approvalMode: 'auto' })).toEqual(
      ['approvalMode'],
    );
  });

  test('treats an EXPLICITLY exempted provider as unrestricted (station-agent)', () => {
    // 'station-agent' (the Station-owned agent relay) is deliberately out
    // of this table's scope: it forwards to /chat, which owns its own option
    // handling. The delegation service (station-control-delegation.ts) layers
    // its own explicit rejection on top for this specific, already-
    // investigated case (a Station agent's modelOptions are provably inert,
    // not merely unmapped) — that product-specific knowledge belongs there.
    //
    // station#2839: this exemption is now NAMED in
    // MODEL_OPTION_UNRESTRICTED_PROVIDERS rather than expressed as absence
    // from the support table. Absence used to mean "unrestricted", so a new
    // provider inherited no restriction until someone remembered to add it.
    expect(
      unsupportedModelOptionKeys('station-agent', { approvalMode: 'auto' }),
    ).toEqual([]);
    expect(MODEL_OPTION_UNRESTRICTED_PROVIDERS).toContain('station-agent');
  });

  test('fails CLOSED for a provider in neither the support table nor the exemption list (station#2839)', () => {
    // The defect this pins: a provider added to the codebase but not yet
    // declared here must not silently receive every modelOption. The old
    // `if (!supported) return []` made "unlisted" mean "unrestricted", and
    // the failure was silent in the permissive direction — the operative
    // key-allowlist defence simply stopped applying.
    expect(
      unsupportedModelOptionKeys('a-newly-added-provider' as never, {
        effort: 'high',
        thinking: true,
      }),
    ).toEqual(['effort', 'thinking']);

    // And it must not be reachable by merely resembling an exempted name.
    expect(
      unsupportedModelOptionKeys('station-agent-lookalike' as never, {
        effort: 'high',
      }),
    ).toEqual(['effort']);
  });

  test('rejects systemPrompt unconditionally, for every provider — review r1 HIGH fix', () => {
    // system-prompt passthrough is explicitly out of station#978's scope.
    // An earlier revision exempted this key unconditionally so
    // `OrchestrationService.runConnectionSmoke`'s internal connectivity
    // probe kept working — but that exemption applied to every caller, so
    // ollama/bedrock (which genuinely read and apply
    // `modelOptions.systemPrompt`) and the CLI's unfiltered
    // `--model-option key=value` escape hatch could silently override an
    // Engine connection's configured system prompt. `runConnectionSmoke`
    // now bypasses this function entirely via a service-internal flag
    // (`dispatchWithReceipt`'s `internal.skipModelOptionSupportCheck`,
    // orchestration-service.ts) instead of this function carrying an
    // exemption reachable by every caller.
    expect(
      unsupportedModelOptionKeys('acp', { systemPrompt: 'be terse' }),
    ).toEqual(['systemPrompt']);
    expect(
      unsupportedModelOptionKeys('ollama', { systemPrompt: 'be terse' }),
    ).toEqual(['systemPrompt']);
    expect(
      unsupportedModelOptionKeys('bedrock', { systemPrompt: 'be terse' }),
    ).toEqual(['systemPrompt']);
    expect(
      unsupportedModelOptionKeys('claude', {
        systemPrompt: 'be terse',
        bogusOption: true,
      }),
    ).toEqual(['systemPrompt', 'bogusOption']);
  });
});

describe('unsupportedModelOptionError', () => {
  test('names the option, the provider, and the target', () => {
    expect(unsupportedModelOptionError('acp', 'approvalMode', 'kiro-1')).toBe(
      "Unsupported option 'approvalMode' for acp target 'kiro-1'",
    );
  });
});
