import type {
  AgentConnectionView,
  EngineRouteObservation,
} from '@kontourai/station-contracts/tool';

/** The saved proxy an engine's models are listed through, by name. */
export function engineModelRouteLabel(
  connection: AgentConnectionView,
): string | null {
  const route = connection.config.modelRoute;
  return route &&
    typeof route === 'object' &&
    'label' in route &&
    typeof route.label === 'string'
    ? route.label
    : null;
}

/**
 * The route the engine actually uses, in the reader's words. `null` for an
 * engine the server does not observe (it reports no route).
 */
export function engineRouteFact(
  observation: EngineRouteObservation | undefined,
): string | null {
  if (!observation) return null;
  switch (observation.kind) {
    case 'proxy':
      return observation.label
        ? `${observation.label} (${observation.origin ?? 'saved proxy'})`
        : (observation.origin ?? 'Saved proxy');
    case 'ambient':
      return observation.origin
        ? `${observation.origin}, from Station's environment`
        : 'Route unknown';
    case 'account':
      return 'Your account';
    default:
      return 'Route unknown';
  }
}

/** Continuity as three short facts, one per dimension. */
export function continuityFacts(
  continuity: AgentConnectionView['continuity'],
): string[] {
  if (!continuity) return ['No native continuity declared.'];
  return [
    continuity.resume === 'same-session'
      ? 'Can continue this execution session when its engine supports it.'
      : 'Cannot resume an existing execution session.',
    continuity.fork === 'native'
      ? 'Can create an engine-native conversation branch.'
      : continuity.fork === 'replay-seed'
        ? 'Can start a new conversation from Station’s transcript. It does not carry engine cursor, tool, or approval state.'
        : 'Cannot create an engine-native branch.',
    continuity.rewind === 'in-place'
      ? 'Can rewind this execution session in place.'
      : 'Cannot rewind an execution session in place.',
  ];
}

/** The last recorded Check connection, or that there has been none. */
export function lastCheckFact(connection: AgentConnectionView): string {
  const smoke = connection.readinessEvidence?.smoke;
  if (!smoke || smoke.status === 'not-tested' || !smoke.testedAt)
    return 'Not checked yet';
  const at = new Date(smoke.testedAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `${smoke.status === 'passed' ? 'Answered' : 'Failed'} · ${at}`;
}
