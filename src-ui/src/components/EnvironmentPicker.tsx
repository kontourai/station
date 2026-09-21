import {
  type EnvironmentRef,
  environmentId,
} from '@kontourai/station-contracts/execution-target';
import {
  usePeerCredentialsQuery,
  useSshEnvironmentsQuery,
} from '@kontourai/station-sdk';
import { useMemo } from 'react';
import {
  peerStationLabel,
  selectablePeerStations,
} from '../utils/peerEnvironmentOptions';

export const MISSING_ENVIRONMENT_NOTICE =
  "This project's saved environment is not available in the current list. Its selection is preserved; choose another environment or repair the connection.";
export const ENVIRONMENTS_UNAVAILABLE_NOTICE =
  'Saved environments are unavailable right now. The configured environment is preserved until the inventory can be loaded.';
export const PEER_ENVIRONMENTS_UNAVAILABLE_NOTICE =
  'Paired Stations are unavailable right now. A saved paired default is preserved until the inventory can be loaded.';

export function EnvironmentPicker({
  id,
  label = 'Default environment',
  value,
  onChange,
}: {
  id: string;
  label?: string;
  value: EnvironmentRef;
  onChange: (value: EnvironmentRef) => void;
}) {
  const { data: environments, isSuccess, isError } = useSshEnvironmentsQuery();
  // Same authorized peer options as the delegation launcher, through the one
  // shared derivation: the `access:manage`-gated read 403s for a non-operator
  // browser session, so peers render only on success and invited-account UI
  // never gains a peer inventory here.
  const peerCredentialsQuery = usePeerCredentialsQuery();
  const peerStations = useMemo(
    () => selectablePeerStations(peerCredentialsQuery.data, environments),
    [environments, peerCredentialsQuery.data],
  );
  const savedId = value.kind === 'saved' ? value.id : null;
  const sshListed = environments?.some(
    (item) => item.profile.environmentId === savedId,
  );
  // `??` would be wrong here: a loaded-but-not-matching SSH list is `false`,
  // not unknown, and must still fall through to the peer list.
  const listed =
    (sshListed ?? false) ||
    peerStations.some((peer) => peer.environmentId === savedId);
  const dangling = Boolean(
    isSuccess && peerCredentialsQuery.isSuccess && savedId && !listed,
  );
  // The peer inventory failed and the saved default is not verifiably an SSH
  // environment, so its peer candidacy is unverified — preserved, not
  // deleted, and named as such.
  const peersBlocked =
    peerCredentialsQuery.isError && Boolean(savedId) && !sshListed;

  return (
    <div className="editor-field environment-picker">
      <label className="editor-label" htmlFor={id}>
        {label}
      </label>
      {/* #765 F5: `editor-select`, the design system's styled select (custom
          chevron, no native appearance) — `editor-input` left this control
          native-looking beside otherwise styled fields. */}
      <select
        id={id}
        className="editor-select"
        value={savedId ?? 'current'}
        onChange={(event) =>
          onChange(
            event.target.value === 'current'
              ? { kind: 'current' }
              : { kind: 'saved', id: environmentId(event.target.value) },
          )
        }
      >
        <option value="current">This Station</option>
        {!listed && savedId && (
          <option value={savedId}>
            {savedId} —{' '}
            {dangling ? 'missing saved environment' : 'saved environment'}
          </option>
        )}
        {(environments ?? [])
          .filter((item) => item.profile.environmentId)
          .map((item) => (
            <option key={item.profile.id} value={item.profile.environmentId!}>
              {item.profile.name}
            </option>
          ))}
        {peerStations.map((peer) => (
          <option key={`peer:${peer.environmentId}`} value={peer.environmentId}>
            {peerStationLabel(peer)} — Paired Station
          </option>
        ))}
      </select>
      {dangling && (
        <p
          className="editor-field-hint environment-picker__notice"
          role="status"
        >
          {MISSING_ENVIRONMENT_NOTICE}
        </p>
      )}
      {isError && savedId && (
        <p
          className="editor-field-hint environment-picker__notice"
          role="alert"
        >
          {ENVIRONMENTS_UNAVAILABLE_NOTICE}
        </p>
      )}
      {peersBlocked && (
        <p
          className="editor-field-hint environment-picker__notice"
          role="alert"
        >
          {PEER_ENVIRONMENTS_UNAVAILABLE_NOTICE}
        </p>
      )}
    </div>
  );
}
