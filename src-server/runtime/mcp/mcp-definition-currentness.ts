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
      // #3483: trust settings do not change the connection; every call reads
      // them fresh, so a person's edit applies without reconnecting.
      contentTrust: _trust,
      untrustedContentPermissions: _permissions,
      trustReadOnlyHints: _hints,
      untrustedContentChanges: _changes,
      untrustedContentPersonOwned: _owned,
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
