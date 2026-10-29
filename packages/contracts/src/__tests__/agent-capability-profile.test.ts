import { describe, expect, test } from 'vitest';
import {
  deriveAgentEditorSurfaces,
  deriveAgentEditorTabs,
} from '../agent-capability-profile';
import { requiresAgentPromptForRuntime } from '../agent-validation';
import {
  ENGINE_CAPABILITY_MATRICES,
  resolveEngineCapabilityMatrix,
  UNKNOWN_EXTERNAL_ENGINE_MATRIX,
} from '../engine-capability-matrix';

describe('agent capability profile', () => {
  // station#1003 Phase B: AgentType/resolveAgentTypeFromRuntimeConnection/
  // requiresAgentPromptForType retired — resolveEngineCapabilityMatrix
  // (engine-capability-matrix.test.ts) and requiresAgentPromptForRuntime's
  // matrix-driven equivalence (agent-validation.test.ts) are the
  // replacements' own coverage; that equivalence was proven against this
  // module's resolver before it was deleted.
  test('keeps provider-model ids out of Station-native prompt delivery (#1055)', () => {
    expect(requiresAgentPromptForRuntime('bedrock-runtime')).toBe(false);
    expect(requiresAgentPromptForRuntime('ollama-runtime')).toBe(false);
    expect(requiresAgentPromptForRuntime('codex')).toBe(false);
  });

  test('a capability surface unsupported by the engine and empty in the spec is hidden', () => {
    const surfaces = deriveAgentEditorSurfaces(
      ENGINE_CAPABILITY_MATRICES.codex,
      {
        prompt: false,
        skills: false,
        tools: false,
        commands: false,
      },
    );
    for (const surface of surfaces) {
      if (surface.key === 'tools' || surface.key === 'prompt') {
        expect(surface.visible).toBe(true);
        expect(surface.mode).toBe('editable');
      } else {
        expect(surface.visible).toBe(false);
      }
    }
  });

  test('authored content the engine cannot deliver renders the surface invalid-readonly, never hidden and never editable', () => {
    const surfaces = deriveAgentEditorSurfaces(
      ENGINE_CAPABILITY_MATRICES.codex,
      {
        prompt: true,
        skills: true,
        tools: true,
        commands: true,
      },
    );
    for (const surface of surfaces) {
      expect(surface.visible).toBe(true);
      expect(surface.mode).toBe(
        surface.key === 'tools' || surface.key === 'prompt'
          ? 'editable'
          : 'invalid-readonly',
      );
    }
  });

  test('commands use the catalog unless authored content is undeliverable', () => {
    const stationTabs = deriveAgentEditorTabs(
      ENGINE_CAPABILITY_MATRICES.station,
      {
        prompt: true,
        skills: true,
        tools: true,
        commands: true,
      },
    );
    expect(stationTabs.map((tab) => tab.key)).toEqual([
      'basic',
      'prompt',
      'skills',
      'tools',
      'engine',
    ]);

    // station#1195: codex's toolServers cell is now deliverable
    // (session/wire), so 'tools' is always present in the codex tab set,
    // even with nothing authored — the same always-present rule Claude's
    // already-deliverable surfaces follow.
    const codexTabsEmpty = deriveAgentEditorTabs(
      ENGINE_CAPABILITY_MATRICES.codex,
      {
        prompt: false,
        skills: false,
        tools: false,
        commands: false,
      },
    );
    expect(codexTabsEmpty.map((tab) => tab.key)).toEqual([
      'basic',
      'prompt',
      'tools',
      'engine',
      'connection',
    ]);

    const codexTabsAuthored = deriveAgentEditorTabs(
      ENGINE_CAPABILITY_MATRICES.codex,
      {
        prompt: true,
        skills: false,
        tools: false,
        commands: true,
      },
    );
    expect(codexTabsAuthored.map((tab) => tab.key)).toEqual([
      'basic',
      'prompt',
      'tools',
      'commands',
      'engine',
      'connection',
    ]);
  });

  test('an unknown external engine derives the conservative all-hidden-unless-authored tab set', () => {
    const tabs = deriveAgentEditorTabs(UNKNOWN_EXTERNAL_ENGINE_MATRIX, {
      prompt: false,
      skills: false,
      tools: false,
      commands: false,
    });
    expect(tabs.map((tab) => tab.key)).toEqual([
      'basic',
      'engine',
      'connection',
    ]);
  });
});

describe('built-in engines derive their real editor tabs (#2301)', () => {
  const authored = {
    prompt: false,
    skills: false,
    tools: false,
    commands: false,
  };
  const tabs = (engineId: string, runtimeId: string) =>
    deriveAgentEditorTabs(
      resolveEngineCapabilityMatrix(engineId, {
        type: runtimeId,
        config: { engineId },
      }),
      authored,
    ).map((tab) => tab.key);

  test('claude exposes the surfaces it can actually deliver', () => {
    // Under the pre-#2301 fallback this was only basic/engine/connection —
    // Prompt, Skills and Tools were hidden for every Claude Code agent.
    expect(tabs('claude', 'claude')).toEqual([
      'basic',
      'prompt',
      'skills',
      'tools',
      'engine',
      'connection',
    ]);
  });

  test('codex exposes tools, which the fallback hid', () => {
    expect(tabs('codex', 'codex')).toEqual([
      'basic',
      'prompt',
      'tools',
      'engine',
      'connection',
    ]);
  });

  test('muse exposes first-message instructions without inventing tool support', () => {
    expect(tabs('muse', 'muse')).toEqual([
      'basic',
      'prompt',
      'engine',
      'connection',
    ]);
  });
});
