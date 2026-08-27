/**
 * Read-adapter: SSH environment profiles → the unified `KnownEnvironment`
 * model (station#1096 R4, AC3). Pure projection — this module never writes
 * to `SshEnvironmentProfileStore`; the SSH environment mechanism
 * (`sshEnvironments.ts`) stays the source of truth for connect/disconnect
 * lifecycle and its own richer 9-phase state machine. This adapter only
 * folds its *identity and reachability* into the cross-mechanism list the
 * Connections hub renders.
 *
 * A profile contributes an `AccessEndpoint` only while its tunnel is
 * actually `connected` (a live `localUrl` to forward through) — an `idle`
 * or `error` profile is still a known environment (it has a label, an
 * SSH-derived source, and possibly an `environmentId` from a prior
 * successful connect), just with zero *current* endpoints. That mirrors
 * `AccessEndpoint`'s own contract: "one concrete way to reach it right
 * now," not a historical record of every port it was ever forwarded on.
 */

import { normalizeBaseUrl } from '@kontourai/station-contracts/http';
import type {
  AccessEndpoint,
  KnownEnvironment,
} from '@kontourai/station-contracts/known-environment';
import { KNOWN_ENVIRONMENT_SCHEMA_VERSION } from '@kontourai/station-contracts/known-environment';
import type { SshEnvironmentView } from './sshEnvironments';

function toEpochMs(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function connectedEndpoint(view: SshEnvironmentView): AccessEndpoint[] {
  if (view.state.phase !== 'connected') return [];
  return [
    {
      id: `endpoint:ssh-forward:${view.profile.id}`,
      httpBaseUrl: normalizeBaseUrl(view.state.localUrl),
      kind: 'ssh-forward',
      preferred: true,
      addedAt: toEpochMs(view.profile.createdAt),
      lastVerifiedAt: toEpochMs(view.state.connectedAt),
    },
  ];
}

/** Adapts one `SshEnvironmentView` (persisted profile + live state) into a `KnownEnvironment`. */
export function sshEnvironmentToKnownEnvironment(
  view: SshEnvironmentView,
): KnownEnvironment {
  const { profile } = view;
  return {
    schemaVersion: KNOWN_ENVIRONMENT_SCHEMA_VERSION,
    id: `ssh-environment:${profile.id}`,
    ...(profile.environmentId ? { environmentId: profile.environmentId } : {}),
    label: profile.name,
    source: 'ssh',
    endpoints: connectedEndpoint(view),
    createdAt: toEpochMs(profile.createdAt),
    updatedAt: toEpochMs(profile.updatedAt),
  };
}

/** Adapts a full SSH environments list, preserving order. */
export function sshEnvironmentsToKnownEnvironments(
  views: readonly SshEnvironmentView[],
): KnownEnvironment[] {
  return views.map(sshEnvironmentToKnownEnvironment);
}
