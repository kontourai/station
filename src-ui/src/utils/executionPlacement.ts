import { PAIRING_SCOPE_ORCHESTRATION_OPERATE } from '@kontourai/station-contracts/environment-security';
import type { PeerCredentialSummary } from '@kontourai/station-sdk';

/**
 * Why a task cannot be placed on another Station. One set of rules, read by
 * both the start composer's Station list (which offers only Stations with no
 * refusal) and the task launcher (which refuses the same cases), so the
 * offer and the refusal cannot drift apart.
 */
export type PlacementRefusal =
  /** An SSH Station whose Project path has not been verified. */
  | 'ssh-unverified'
  /**
   * An SSH Station with a Project selected: SSH carries no portable Project
   * identity, so a Project is never placed there (#480).
   */
  | 'ssh-with-project'
  /** A paired Station whose credential cannot start work there. */
  | 'peer-cannot-operate';

export function sshPlacementRefusals(
  profile: {
    environmentId?: string | null;
    verifiedProjectPath?: string | null;
  },
  projectSelected: boolean,
): PlacementRefusal[] {
  const refusals: PlacementRefusal[] = [];
  if (!profile.environmentId || !profile.verifiedProjectPath)
    refusals.push('ssh-unverified');
  if (projectSelected) refusals.push('ssh-with-project');
  return refusals;
}

/**
 * Starting work on a paired Station is an operate-tier request there, so the
 * stored credential's scope must include `orchestration:operate` as a whole
 * token. Unknown tokens beside it are ignored, never a reason to refuse.
 */
export function peerPlacementRefusals(
  peer: Pick<PeerCredentialSummary, 'scope'>,
): PlacementRefusal[] {
  return peer.scope.split(/\s+/).includes(PAIRING_SCOPE_ORCHESTRATION_OPERATE)
    ? []
    : ['peer-cannot-operate'];
}
