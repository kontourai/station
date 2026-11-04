import { PROVIDER_CODEX } from '@kontourai/station-contracts/provider';
import { isDeferredRetriableTurnError } from '@kontourai/station-contracts/runtime-events';
import type {
  UsageTerminalEngine,
  UsageTerminalOutcome,
} from '@kontourai/station-contracts/usage-export';

/**
 * The one canonical turn-terminal classification (#3460). Live engine-turn
 * telemetry and the consented operational export both use it: a completed or
 * aborted turn, or a turn-scoped `runtime.error` that is not codex's deferred
 * retry arm. A deferred retry is not yet an outcome, so it is never counted as
 * a failure.
 */
export function canonicalTerminalOutcome(event: {
  method: string;
  turnId?: string;
  provider?: string;
  retriable?: boolean;
}): UsageTerminalOutcome | undefined {
  const { method, turnId, provider, retriable } = event;
  if (method === 'turn.completed') return 'completed';
  if (method === 'turn.aborted') return 'aborted';
  if (
    method === 'runtime.error' &&
    turnId &&
    !isDeferredRetriableTurnError({ method, provider, retriable })
  )
    return 'failed';
  return undefined;
}

/**
 * SQL prefilter over `orchestration_events e` for the same rule. It is a
 * superset guard only; every selected row is still classified by
 * {@link canonicalTerminalOutcome}, so the two cannot silently diverge.
 */
export const CANONICAL_TERMINAL_EVENT_SQL = `(e.method IN ('turn.completed', 'turn.aborted')
  OR (e.method = 'runtime.error' AND e.turn_id IS NOT NULL
      AND NOT (e.provider = '${PROVIDER_CODEX}' AND json_valid(e.payload)
               AND COALESCE(json_extract(e.payload, '$.retriable'), 0) = 1)))`;

const ENGINES: readonly UsageTerminalEngine[] = [
  'station',
  'acp',
  'bedrock',
  'claude',
  'codex',
  'muse',
  'ollama',
];
/** Engine family only; an unrecognized provider id is never released verbatim. */
export function terminalEngineFamily(provider: string): UsageTerminalEngine {
  return (ENGINES as readonly string[]).includes(provider)
    ? (provider as UsageTerminalEngine)
    : 'other';
}
