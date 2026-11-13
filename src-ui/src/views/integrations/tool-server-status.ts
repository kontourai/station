import type { IntegrationViewModel } from '@kontourai/station-sdk';
import { connectionVerdictTone } from '../../components/kontour/station-tones';
import type { ResourceStatus } from '../../components/resource-hub/resource-status';

/**
 * A tool server's status from its last probe, in the recorded readiness
 * labels. Station's own servers are run by Station and have no probe.
 */
export function toolServerStatus(server: IntegrationViewModel): ResourceStatus {
  if (server.enabled === false)
    return { label: 'Disabled', tone: connectionVerdictTone('off') };
  if (server.builtin)
    return { label: 'Ready', tone: connectionVerdictTone('ready') };
  const probe = server.probe;
  const authorization = probe?.authorization;
  if (authorization && authorization.state !== 'authorized')
    return {
      label: 'Sign in required',
      tone: connectionVerdictTone('setup'),
      reason:
        'reason' in authorization
          ? authorization.reason
          : 'Sign in to this tool server.',
    };
  if (!probe)
    return {
      label: 'Saved — not verified',
      tone: connectionVerdictTone('setup'),
    };
  if (probe.ok) return { label: 'Ready', tone: connectionVerdictTone('ready') };
  return {
    label: 'Check failed',
    tone: connectionVerdictTone('failing'),
    ...(probe.error ? { reason: probe.error } : {}),
  };
}

/** The row's probe fact: tool count and when it was last checked. */
export function toolServerProbeFact(
  server: IntegrationViewModel,
): string | null {
  if (server.builtin) {
    const count = server.tools?.length ?? 0;
    return `${count} ${count === 1 ? 'tool' : 'tools'}`;
  }
  const probe = server.probe;
  if (!probe) return null;
  const checked = new Date(probe.checkedAt);
  const when = Number.isNaN(checked.getTime())
    ? null
    : `checked ${checked.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  if (!probe.ok) return when;
  const tools = `${probe.toolCount} ${probe.toolCount === 1 ? 'tool' : 'tools'}`;
  return when ? `${tools}, ${when}` : tools;
}
