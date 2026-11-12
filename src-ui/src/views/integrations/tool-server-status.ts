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

/** At most this many tool servers start at once during Check all. */
export const CHECK_ALL_CONCURRENCY = 3;

export interface CheckAllPlan {
  probe: IntegrationViewModel[];
  /** Servers a probe could ask to sign in; Check all never starts that. */
  skipped: IntegrationViewModel[];
}

/**
 * Which servers Check all probes. Station's own and turned-off servers are
 * left out. A probe of a remote server can begin a sign-in (OAuth) flow, so
 * one is probed only when its last probe passed without any sign-in; every
 * other remote server, and any server signed in per person, is skipped and
 * named. A local (stdio) server never signs in.
 */
export function planCheckAll(
  servers: readonly IntegrationViewModel[],
): CheckAllPlan {
  const plan: CheckAllPlan = { probe: [], skipped: [] };
  for (const server of servers) {
    if (server.builtin || server.enabled === false) continue;
    const remote =
      server.transport === 'sse' || server.transport === 'streamable-http';
    const mayAskToSignIn =
      !!server.credentialOwnership ||
      (remote && (!server.probe?.ok || !!server.probe.authorization));
    (mayAskToSignIn ? plan.skipped : plan.probe).push(server);
  }
  return plan;
}

/**
 * Runs `task` for each item with at most `limit` in flight, in order. Every
 * item settles; the result keeps input order.
 */
export async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = {
          status: 'fulfilled',
          value: await task(items[index] as T),
        };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker),
  );
  return results;
}
