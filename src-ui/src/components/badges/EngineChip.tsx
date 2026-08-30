import type { EngineDescriptor } from '../../utils/engine';
import './EngineChip.css';

interface EngineChipProps {
  engine: EngineDescriptor | null;
  className?: string;
}

/**
 * The quiet engine-identity chip (docs/design/agent-engine-unification.md
 * §8.1): one pill naming the engine that executes an agent — "Station",
 * "Claude Code", "Codex", "OpenCode - GLM-4.7". `engine === null` means the
 * caller could not resolve the agent — render nothing rather than
 * guess.
 *
 * Visually mirrors the Connections hub's `connections-page__status-badge`
 * family (same size/weight/radius/tone), via a locally scoped equivalent
 * class so the chip renders correctly wherever agents show up (new-chat
 * picker, agent lists, session tabs, hub cards) without depending on the
 * Connections hub's own stylesheet having been loaded.
 */
/**
 * What the chip WILL say. A caller deciding whether the chip repeats the
 * agent's name (Y1) has to compare against this, not against `engine.name`:
 * an ACP engine's chip is "OpenCode - GLM-4.7" while its `name` is
 * "OpenCode", so comparing names dropped a chip that was carrying the model.
 */
export function engineChipLabel(engine: EngineDescriptor | null): string {
  if (!engine) return '';
  return engine.model ? `${engine.name} - ${engine.model}` : engine.name;
}

export function EngineChip({ engine, className = '' }: EngineChipProps) {
  if (!engine) return null;
  return (
    <span className={`engine-chip ${className}`.trim()}>
      <span className="engine-chip__pill">{engineChipLabel(engine)}</span>
    </span>
  );
}
