import { createHash } from 'node:crypto';
import type { AgentSpec } from '@kontourai/station-contracts/agent';

/** Hash the authored definition, excluding execution and local presentation/provenance. */
export function agentDefinitionFingerprint(spec: AgentSpec): string {
  const {
    execution: _execution,
    icon: _icon,
    provenance: _provenance,
    ...definition
  } = spec;
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
