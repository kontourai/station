/**
 * One answer to "can I use this connection now?" (connections-overhaul
 * design record, "One readiness derivation"). The section rail, the
 * `/connections` resolver and the Engines and Models list rows read this
 * function, so they cannot disagree about the same connection.
 *
 * Labels, reasons and fixes are `resolveProviderPresentation`'s recorded,
 * finite readiness words; this only ranks its answer against evidence the
 * resolver does not read (managed policy, an added engine's observed status)
 * and puts it on a verdict scale. It never reads Ready where the server
 * would refuse to dispatch: an engine runs only when it is enabled and its
 * status is `ready` (`isHonestlyAvailableConnectedAgent` in
 * `src-server/routes/agents/enriched-agents.ts`), so a degraded engine the
 * resolver labels "Limited" is not ready here.
 *
 * Provider-reported allowance is deliberately not an input: it needs
 * credential-management access and a live provider call, so feeding it to
 * the rail or rows would poll every engine and give each viewer a different
 * verdict.
 */

import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import { connectionVerdictTone } from '../../components/kontour/station-tones';
import type { ResourceStatus } from '../../components/resource-hub/resource-status';
import {
  blockingPrerequisite,
  type ProviderCatalogInput,
  type ProviderReadiness,
  prerequisiteRemedy,
  resolveProviderPresentation,
} from '../provider-settings/providerCatalog';
import type { ProviderConnection } from '../provider-settings/types';

/**
 * Internal verdict scale; never shown as words. Only `ready` means usable
 * now, and everything else needs attention.
 */
export type ConnectionVerdict =
  | 'ready'
  | 'degraded'
  | 'failing'
  | 'setup'
  | 'off';

export interface ConnectionHealth extends ResourceStatus {
  verdict: ConnectionVerdict;
}

/**
 * Every resolver label on the verdict scale. Keyed by the resolver's own
 * label type, so a new label is a typecheck failure here, not a silent Ready.
 */
const READINESS_VERDICT: Record<ProviderReadiness, ConnectionVerdict> = {
  Ready: 'ready',
  'Sign in required': 'setup',
  'API key required': 'setup',
  'Credentials required': 'setup',
  'Found, not connected': 'setup',
  'Not installed': 'setup',
  'Setup required': 'setup',
  // Saved settings nobody has tested: the fix is a test, done here.
  'Saved — not verified': 'setup',
  'Reachable — no model catalog': 'degraded',
  'Unreachable — retrying': 'degraded',
  Limited: 'degraded',
  'Check failed': 'failing',
  'Cannot reach provider': 'failing',
  Unreachable: 'failing',
  Disabled: 'off',
};

export interface ConnectionHealthEvidence {
  /**
   * The managed policy does not allow this engine. Kept distinct from
   * Disabled: there is nothing the reader can turn on.
   */
  policyDisallowed?: boolean;
}

export function engineHealthInput(
  connection: AgentConnectionView,
): ProviderCatalogInput {
  return {
    id: connection.id,
    kind: 'agent',
    type: connection.type,
    name: connection.name,
    enabled: connection.enabled,
    status: connection.status,
    prerequisites: connection.prerequisites,
    ...(connection.readinessEvidence
      ? { readinessEvidence: connection.readinessEvidence }
      : {}),
    setup: connection.setup,
    href: '',
  };
}

export function modelHealthInput(
  connection: ProviderConnection,
): ProviderCatalogInput {
  return {
    id: connection.id,
    kind: 'model',
    type: connection.type,
    name: connection.name,
    enabled: connection.enabled,
    status: connection.status,
    prerequisites: connection.prerequisites,
    ...(connection.readinessEvidence
      ? { readinessEvidence: connection.readinessEvidence }
      : {}),
    setup: null,
    href: '',
  };
}

/** Engine statuses that are observations, not placement. */
const OBSERVED_ENGINE_STATUSES = new Set(['error', 'disconnected', 'degraded']);

type Presentation = ReturnType<typeof resolveProviderPresentation>;

/**
 * The resolver places an added engine that is not ready under "Setup
 * required" before it reads the engine's observed status, so an engine the
 * server reports as failing or degraded read as needing setup. Here the
 * observation outranks the placement: the same resolver, asked about the
 * status alone, names it ("Unreachable", "Limited") in its own words.
 */
function observedPresentation(
  input: ProviderCatalogInput,
  presentation: Presentation,
): Presentation {
  if (
    input.setup?.state !== 'configured' ||
    presentation.readiness !== 'Setup required' ||
    !OBSERVED_ENGINE_STATUSES.has(input.status)
  )
    return presentation;
  return resolveProviderPresentation({
    id: input.id,
    kind: input.kind,
    type: input.type,
    name: input.name,
    enabled: input.enabled,
    status: input.status,
    href: input.href,
    ...(input.readOnly ? { readOnly: input.readOnly } : {}),
    setup: null,
  });
}

function health(
  verdict: ConnectionVerdict,
  presentation: Presentation,
  actionId: string,
): ConnectionHealth {
  return {
    verdict,
    label: presentation.readiness,
    tone: connectionVerdictTone(verdict),
    // Ready needs no reason and offers no fix; "Details" is not a fix.
    ...(verdict === 'ready'
      ? {}
      : {
          reason: presentation.detail,
          action: { label: presentation.actionLabel, id: actionId },
        }),
  };
}

/**
 * The verdict, in this order: not allowed by policy, or turned off (off); a
 * blocking prerequisite (setup, with its fix); a failed check or an
 * unreachable endpoint (failing); otherwise the resolver's label — except
 * that an engine the server would not dispatch is never ready.
 */
export function deriveConnectionHealth(
  input: ProviderCatalogInput,
  evidence: ConnectionHealthEvidence = {},
): ConnectionHealth {
  if (evidence.policyDisallowed)
    return {
      verdict: 'off',
      label: 'Not allowed',
      tone: connectionVerdictTone('off'),
      reason: 'Your organization does not allow this engine.',
    };
  const presentation = resolveProviderPresentation(input);
  if (READINESS_VERDICT[presentation.readiness] === 'off')
    return health('off', presentation, 'enable');
  const blocker = blockingPrerequisite(input.prerequisites ?? []);
  if (blocker)
    return health('setup', presentation, prerequisiteRemedy(blocker));
  const observed = observedPresentation(input, presentation);
  const verdict = READINESS_VERDICT[observed.readiness];
  if (verdict === 'failing') return health(verdict, observed, 'check');
  if (
    verdict === 'ready' &&
    input.kind === 'agent' &&
    input.status !== 'ready'
  ) {
    // The resolver can read Ready from setup placement alone; dispatch
    // reads status. Report the status in the resolver's own words, and
    // never as ready.
    const byStatus = resolveProviderPresentation({
      id: input.id,
      kind: input.kind,
      type: input.type,
      name: input.name,
      enabled: input.enabled,
      status: input.status,
      href: input.href,
      setup: null,
    });
    const statusVerdict = READINESS_VERDICT[byStatus.readiness];
    const notReady = statusVerdict === 'ready' ? 'degraded' : statusVerdict;
    return health(
      notReady,
      byStatus,
      notReady === 'failing' ? 'check' : 'review',
    );
  }
  return health(verdict, observed, verdict === 'setup' ? 'setup' : 'review');
}
