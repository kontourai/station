import type { EngineId } from './agent-identity.js';

/** The one canonical conversion from engine identity to user-visible name. */
export function engineDisplayLabel(engineId: EngineId): string | null {
  switch (engineId) {
    case 'station':
    case 'station-agent':
    case 'bedrock':
    case 'ollama':
      return 'Station';
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'muse':
      return 'Muse Code';
    case 'acp':
      return 'Custom engine';
    default:
      return null;
  }
}
