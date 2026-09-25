import type { PeerCredentialSummary } from '@kontourai/station-sdk';

interface SshEnvironmentLike {
  profile: { environmentId?: string | null };
}

/**
 * Paired-peer Stations selectable as execution targets (#480/#1964
 * placement). One derivation shared by the delegation launcher and the
 * Project default-environment picker so the two surfaces listing the same
 * Station cannot disagree about which peers are candidates: a peer whose
 * environmentId already resolves through a saved SSH profile is listed once,
 * as its SSH entry (server-side `resolveTarget` rides the peer credential
 * over that tunnel — a second entry would dispatch identically), and
 * `current` stays this select's "This Station" sentinel, never a peer.
 *
 * Summaries only — environmentId/label/apiBase for display and dispatch. The
 * stored credential never leaves the server; nothing here reads or forwards
 * it.
 */
export function selectablePeerStations<
  TEnvironment extends SshEnvironmentLike,
  TPeer extends Pick<PeerCredentialSummary, 'environmentId'>,
>(
  peerCredentials: readonly TPeer[] | undefined,
  environments: readonly TEnvironment[] | undefined,
): TPeer[] {
  const sshEnvironmentIds = new Set(
    (environments ?? [])
      .map((environment) => environment.profile.environmentId)
      .filter(Boolean),
  );
  return (peerCredentials ?? []).filter(
    (peer) =>
      !sshEnvironmentIds.has(peer.environmentId) &&
      peer.environmentId !== 'current',
  );
}

/** Display name for a peer option; the endpoint stands in when unlabeled. */
export function peerStationLabel(
  peer: Pick<PeerCredentialSummary, 'apiBase' | 'label'>,
): string {
  return peer.label ?? peer.apiBase;
}
