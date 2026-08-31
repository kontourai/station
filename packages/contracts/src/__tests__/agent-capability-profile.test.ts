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
  test('keeps prompt affordances tied to the matrix-resolved engine', () => {
    expect(requiresAgentPromptForRuntime('bedrock-runtime')).toBe(true);
    expect(requiresAgentPromptForRuntime('ollama-runtime')).toBe(true);
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
      // station#1195: codex's toolServers cell is now deliverable
      // (session/wire), so the 'tools' surface is always visible+editable
      // regardless of authored content — every OTHER codex surface
      // (prompt/skills/commands) stays unsupported-and-empty-so-hidden.
      if (surface.key === 'tools') {
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
      // station#1195: 'tools' is now deliverable for codex, so authoring it
      // renders normally editable — the invalid-readonly rule now applies
      // only to the still-unsupported prompt/skills/commands surfaces.
      expect(surface.mode).toBe(
        surface.key === 'tools' ? 'editable' : 'invalid-readonly',
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
    expect(tabs('claude-code', 'claude')).toEqual([
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
      'tools',
      'engine',
      'connection',
    ]);
  });

  test('muse stays minimal, because its matrix genuinely declares no such surface', () => {
    // Guards against reading the fix as "more tabs everywhere": muse's cells
    // are unsupported by design, so its tab set must NOT grow.
    expect(tabs('muse', 'muse')).toEqual(['basic', 'engine', 'connection']);
  });
});
