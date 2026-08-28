import type {
  AgentCapabilitySurface,
  AuthoredCapabilityFlags,
} from './agent-validation.js';
import type { EngineCapabilityMatrix } from './engine-capability-matrix.js';

/**
 * `AgentType`/`resolveAgentTypeFromRuntimeConnection` are retired
 * (archive#1003) — the matrix-driven `EngineCapabilityMatrix`
 * (`engine-capability-matrix.ts`) is now the single source of truth for
 * engine-derived capability/tab decisions; see
 * `requiresAgentPromptForRuntime` (`agent-validation.ts`) and
 * `isExternalEngineBoundAgent` (`runtime-agent-registry.ts`) for the
 * matrix-driven replacements.
 */
export type AgentEditorTabKey =
  | 'basic'
  | 'skills'
  | 'tools'
  | 'commands'
  | 'connection'
  | 'prompt'
  | 'engine';

export interface AgentEditorTab {
  key: AgentEditorTabKey;
  label: string;
}

export interface AgentEditorSurfaceState {
  key: AgentCapabilitySurface;
  visible: boolean;
  mode: 'editable' | 'invalid-readonly';
}

const SURFACE_TO_MATRIX_KEY: Record<
  AgentCapabilitySurface,
  keyof Pick<
    EngineCapabilityMatrix,
    'systemPrompt' | 'skills' | 'toolServers' | 'commands'
  >
> = {
  prompt: 'systemPrompt',
  skills: 'skills',
  tools: 'toolServers',
  commands: 'commands',
};

const SURFACE_ORDER: AgentCapabilitySurface[] = [
  'prompt',
  'skills',
  'tools',
  'commands',
];

/**
 * Station#975 §5's per-surface rendering rule: supported by the engine ->
 * visible & editable; unsupported and nothing authored -> hidden entirely;
 * unsupported but the agent has authored content for it -> visible,
 * read-only, never silently dropped and never silently hidden.
 */
export function deriveAgentEditorSurfaces(
  matrix: EngineCapabilityMatrix,
  authored: AuthoredCapabilityFlags,
): AgentEditorSurfaceState[] {
  return SURFACE_ORDER.map((key) => {
    const supported =
      matrix[SURFACE_TO_MATRIX_KEY[key]].state !== 'unsupported';
    if (supported) {
      return { key, visible: true, mode: 'editable' as const };
    }
    if (authored[key]) {
      return { key, visible: true, mode: 'invalid-readonly' as const };
    }
    return { key, visible: false, mode: 'editable' as const };
  });
}

const SURFACE_TAB_KEY: Record<AgentCapabilitySurface, AgentEditorTabKey> = {
  prompt: 'prompt',
  skills: 'skills',
  tools: 'tools',
  commands: 'commands',
};

const SURFACE_TAB_LABEL: Record<AgentCapabilitySurface, string> = {
  prompt: 'Prompt',
  skills: 'Skills',
  tools: 'Tools',
  commands: 'Commands',
};

/**
 * Station#975 D-1/§8.2: basic, then visible capability surfaces in
 * prompt|skills|tools|commands order, then Engine (always present — every
 * agent has an engine), then Connection (only for a non-station engine —
 * Station's own model plumbing lives on the Engine tab, so Connection would
 * be empty transport info for it).
 */
export function deriveAgentEditorTabs(
  matrix: EngineCapabilityMatrix,
  authored: AuthoredCapabilityFlags,
): AgentEditorTab[] {
  const tabs: AgentEditorTab[] = [{ key: 'basic', label: 'Basic' }];
  for (const surface of deriveAgentEditorSurfaces(matrix, authored)) {
    if (surface.visible) {
      // Deliverable commands are browsed in Guidance rather than configured
      // per agent. The editor owns this surface only when persisted authored
      // commands are invalid for the selected engine and must remain
      // inspectable under the authored-content convention above.
      if (surface.key === 'commands' && surface.mode === 'editable') continue;
      tabs.push({
        key: SURFACE_TAB_KEY[surface.key],
        label: SURFACE_TAB_LABEL[surface.key],
      });
    }
  }
  tabs.push({ key: 'engine', label: 'Engine' });
  if (matrix.engineId !== 'station') {
    tabs.push({ key: 'connection', label: 'Connection' });
  }
  return tabs;
}
