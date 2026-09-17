import { isDeepStrictEqual } from 'node:util';
import type { ToolDef } from '@kontourai/station-contracts/tool';

/** Connection policy, not probe/presentation revision; never emitted or logged. */
export function sameMCPConnectionDefinition(
  left: ToolDef,
  right: ToolDef,
): boolean {
  const policy = (value: ToolDef) => {
    const {
      probe: _probe,
      displayName: _name,
      description: _description,
      icon: _icon,
      healthCheck: _health,
      ...connection
    } = value;
    // loadIntegration hydrates legacy credential values and a synthesized
    // enabled marker; updateIntegration receives the persisted projection.
    const env = { ...connection.env };
    for (const name of connection.storedEnvNames ?? []) delete env[name];
    return {
      ...Object.fromEntries(Object.entries(connection)),
      enabled: value.enabled !== false,
      env,
    };
  };
  return isDeepStrictEqual(policy(left), policy(right));
}
