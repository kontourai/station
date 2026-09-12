/**
 * The one readiness notice, for every kind of connection.
 *
 * Two near-identical pages grew two different notices, and each was missing
 * what the other had. The engine page rendered the blocking prerequisite and
 * its install guide but never the server's readiness `evidence`; the model page
 * rendered `evidence.summary`/`evidence.action` but never a prerequisite, never
 * an install guide, and never named the machine any of it was about. A user
 * hitting the same class of problem got a different amount of help depending on
 * which page they were standing on.
 *
 * This renders the union, from whatever the caller actually has. Nothing here
 * invents state: `readiness` and `detail` come from the shared resolver, the
 * prerequisite and its guide come from the server, and the sentence naming a
 * second machine comes from `host-action-copy`'s map rather than from this
 * file — so a surface still cannot re-word or re-classify a host action at its
 * call site.
 */

import type { DevicePresentation } from '@kontourai/station-contracts/system-status';
import type {
  ConnectionReadinessEvidence,
  Prerequisite,
} from '@kontourai/station-contracts/tool';
import {
  blockingPrerequisite,
  hostActionIdForRemedy,
  prerequisiteRemedy,
} from '../../views/provider-settings/providerCatalog';
import { HostAction } from '../host-action/HostAction';

interface ConnectionReadinessNoticeProps {
  /** The resolver's verdict. Never composed here. */
  readiness: string;
  /** The resolver's reason, already preferring the prerequisite's own text. */
  detail: string;
  /** Decides which host-naming entry applies; engines and models differ. */
  kind: 'agent' | 'model' | 'command';
  prerequisites: Prerequisite[];
  /** The server's own readiness observation, where this connection has one. */
  evidence?: ConnectionReadinessEvidence | undefined;
  devicePresentation: DevicePresentation | undefined;
}

export function ConnectionReadinessNotice({
  readiness,
  detail,
  kind,
  prerequisites,
  evidence,
  devicePresentation,
}: ConnectionReadinessNoticeProps) {
  const blocker = blockingPrerequisite(prerequisites);
  const steps = blocker?.installGuide?.steps ?? [];
  // The resolver already prefers the blocking prerequisite's description, so
  // an identical `summary` would render the same sentence twice.
  const summary =
    evidence?.summary && evidence.summary !== detail ? evidence.summary : null;

  return (
    <div className="provider-detail__notice" role="status">
      <strong>{readiness}</strong>
      <span>{detail}</span>
      {summary && <span>{summary}</span>}
      {evidence?.action && <span>{evidence.action}</span>}
      {blocker && (
        <>
          <HostAction
            id={hostActionIdForRemedy(prerequisiteRemedy(blocker), kind)}
            presentation={devicePresentation}
            command={blocker.installGuide?.commands?.[0]}
          />
          <span className="provider-detail__notice-subject">
            {blocker.name}
          </span>
          {steps.length > 0 && (
            <ol className="provider-detail__notice-steps">
              {steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
