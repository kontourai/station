import { createHash } from 'node:crypto';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import {
  isStationAgentIdentity,
  LEGACY_STATION_AGENT_NAME,
  STATION_AGENT_DISPLAY_NAME,
} from '@kontourai/station-contracts/agent-identity';

/** Hash the authored definition, excluding execution and local presentation/provenance. */
export function agentDefinitionFingerprint(
  spec: AgentSpec,
  slug?: string,
): string {
  const {
    execution: _execution,
    icon: _icon,
    provenance: _provenance,
    ...definition
  } = spec;
  // The reserved Agent has the same display-name projection at discovery
  // and execution; a legacy on-disk name is not an authored edit.
  if (
    slug &&
    isStationAgentIdentity(slug) &&
    definition.name === LEGACY_STATION_AGENT_NAME
  )
    definition.name = STATION_AGENT_DISPLAY_NAME;
  const canonical = JSON.stringify(definition, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : value,
  );
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
