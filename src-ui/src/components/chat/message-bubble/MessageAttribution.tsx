import type { EngineDescriptor } from '../../../utils/engine';
import type { OwnerAttribution } from '../../../utils/ownerAttribution';
import type { PermissionPosture } from '../../../utils/sessionDisplay';
import { EngineChip } from '../../badges/EngineChip';
import { OwnerChip } from '../../badges/OwnerChip';
import { PermissionPostureBadge } from '../../badges/PermissionPostureBadge';

interface MessageAttributionAgent {
  name: string;
}

interface MessageAttributionProps {
/**
 * Agent identity text (archive#1424 fix): no icon here — the
* row already renders one avatar per message (`MessageBubble`'s
* `.message-row__avatar` / `StreamingMessage`'s `.streaming-message-icon`,
* both `AgentIcon`), so a second, smaller icon inside the strip was pure
* duplication, not a second identity. `null` when the agent is genuinely
* unresolved — this never falls back to a placeholder name like "AI".
*/
  agent: MessageAttributionAgent | null;
/**
* Already-resolved engine identity for THIS turn — this component never
* resolves engine identity itself. On a persisted row the caller reads it
* from the turn's own provenance envelope (`resolveTurnEngine`,
* archive#1434); a caller with no per-turn record passes `null` and no
* chip renders.
*/
  engine: EngineDescriptor | null;
  owner?: OwnerAttribution | null;
  permissionPosture?: PermissionPosture | null;
  className?: string;
}

export function normalizedDisplayLabel(value: string | undefined): string {
  return (value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('en-US');
}

/**
 * Additive identity strip for an agent-authored chat/stream row
 * (archive#1424): agent identity, engine chip, owner attribution, and
 * permission posture. Annotation, not segregation — this renders inside the
 * existing row/bubble shape, never a second row layout. Any prop left
 * unresolved (null/undefined) simply omits its chip; the whole component
 * renders nothing when there is nothing to show.
 */
export function MessageAttribution({
  agent,
  engine,
  owner,
  permissionPosture,
  className = '',
}: MessageAttributionProps) {
  if (!agent && !engine && !owner && !permissionPosture) return null;
  return (
    <div className={`message-attribution ${className}`.trim()}>
      {agent &&
        normalizedDisplayLabel(agent.name) !==
          normalizedDisplayLabel(engine?.name) && (
          <span className="message-attribution__agent-name">{agent.name}</span>
        )}
      <EngineChip engine={engine} />
      <OwnerChip owner={owner ?? null} />
      <PermissionPostureBadge posture={permissionPosture ?? null} />
    </div>
  );
}
