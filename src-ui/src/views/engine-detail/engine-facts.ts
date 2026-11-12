import type { EngineAllowanceEvidence } from '@kontourai/station-contracts/engine-accounts';
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
 * The route the engine actually uses, in the reader's words, with one line
 * of help where the value alone would mislead. `null` for an engine the
 * server does not observe (it reports no route).
 *
 * `account` is not shown as "Your account": Station sees no endpoint
 * override in its own launch, but the engine's settings files can still
 * route it, so the route is unobserved (docs/design/connections-overhaul.md).
 */
export function engineRouteFact(
  observation: EngineRouteObservation | undefined,
): { value: string; note?: string } | null {
  if (!observation) return null;
  switch (observation.kind) {
    case 'proxy':
      return {
        value: observation.label
          ? `${observation.label} (${observation.origin ?? 'saved proxy'})`
          : (observation.origin ?? 'Saved proxy'),
      };
    case 'ambient':
      // Without an origin, the server withheld it from this viewer.
      return observation.origin
        ? {
            value: `${observation.origin}, ${AMBIENT_SOURCE[observation.source ?? 'station']}`,
          }
        : {
            value: `Another endpoint, ${AMBIENT_SOURCE[observation.source ?? 'station']}`,
            note: 'Your access does not include where it points.',
          };
    case 'account':
      return {
        value: 'Route unknown',
        note: "No endpoint override in Station's launch; engine settings files can still route it.",
      };
    default:
      return {
        value: 'Route unknown',
        note: 'Station sees an endpoint override it cannot name.',
      };
  }
}

const AMBIENT_SOURCE = {
  connection: "from this engine's saved settings",
  policy: "set by your organization's policy",
  station: "from Station's environment",
} as const;

/**
 * The same endpoint as one sentence under Connect through, where "Your
 * account" alone would not be the whole story. The engine's own saved
 * settings already show there as custom settings.
 */
export function ambientRouteNote(
  observation: EngineRouteObservation | undefined,
): string | undefined {
  if (observation?.kind !== 'ambient') return undefined;
  if (observation.source === 'connection') return undefined;
  const where = observation.origin ?? 'another endpoint';
  return observation.source === 'policy'
    ? `Your organization's policy sends this engine to ${where}.`
    : `Station's environment sends this engine to ${where}.`;
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

const ALLOWANCE_ACCOUNT: Record<EngineAllowanceEvidence['applies'], string> = {
  'current-account': "This engine's account",
  'other-account': 'Another account',
  'proxy-route': 'Its account, not used while routed through a proxy',
};

function shortTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * One line per account the provider refused a turn on, still fresh. The
 * header carries the current account's reason, so its line names only the
 * account and when; another account's line adds its reset. Empty when
 * nothing fresh is recorded, which is unknown, not allowance left.
 */
export function allowanceFacts(
  connection: AgentConnectionView,
  now: number = Date.now(),
): string[] {
  return (connection.allowanceEvidence ?? [])
    .filter((evidence) => Date.parse(evidence.expiresAt) > now)
    .map((evidence) => {
      const account =
        evidence.applies === 'other-account' &&
        evidence.account.kind === 'profile'
          ? `Saved account ${evidence.account.ref}`
          : evidence.applies === 'other-account'
            ? 'The default account'
            : ALLOWANCE_ACCOUNT[evidence.applies];
      const reset =
        evidence.applies === 'current-account'
          ? ''
          : evidence.resetAt
            ? ` · resets ${shortTime(evidence.resetAt)}`
            : evidence.resetReported
              ? ` · resets ${evidence.resetReported} (provider time)`
              : '';
      return `${account} · refused ${shortTime(evidence.observedAt)}${reset}`;
    });
}
