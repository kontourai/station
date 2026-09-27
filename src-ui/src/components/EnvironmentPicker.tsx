import {
  type EnvironmentRef,
  environmentId,
} from '@kontourai/station-contracts/execution-target';
import {
  usePeerCredentialsQuery,
  useSshEnvironmentsQuery,
} from '@kontourai/station-sdk';
import { useMemo } from 'react';
import { selectablePeerStations } from '../utils/peerEnvironmentOptions';

export const MISSING_ENVIRONMENT_NOTICE =
  "This project's saved environment is not available in the current list. Its selection is preserved; choose another environment or repair the connection.";
export const ENVIRONMENTS_UNAVAILABLE_NOTICE =
  'Saved environments are unavailable right now. The configured environment is preserved until the inventory can be loaded.';
const PEER_ENVIRONMENTS_UNAVAILABLE_NOTICE =
  'Paired Stations are unavailable right now. A saved paired default is preserved until the inventory can be loaded.';
/**
 * #480 final scope correction: the FOREGROUND thread-execution path has no
 * portable identity or receiver-offer admission, so this picker must not
 * offer NEW paired-Station selections — placing a Project there would run
 * an unrelated same-slug Project on the peer. An already-saved paired
 * default stays visible and preserved, named as not yet supported here,
 * never silently substituted with the current Station. The portable
 * DELEGATION launcher keeps its own authorized peer options.
 */
const PEER_DEFAULT_UNSUPPORTED_NOTICE =
  'This project\u2019s saved default is a paired Station. The selection is preserved, but starting new threads on paired Stations isn\u2019t supported here yet.';

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
  // The `access:manage`-gated peer read is used ONLY to classify an
  // already-saved default (and to name the unavailable state); it offers no
  // new peer selections (see PEER_DEFAULT_UNSUPPORTED_NOTICE). It 403s for
  // a non-operator browser session, so invited-account UI never gains a
  // peer inventory here. The portable delegation launcher keeps its own
  // authorized peer options through the same shared derivation.
  const peerCredentialsQuery = usePeerCredentialsQuery();
  const peerStations = useMemo(
    () => selectablePeerStations(peerCredentialsQuery.data, environments),
    [environments, peerCredentialsQuery.data],
  );
  const savedId = value.kind === 'saved' ? value.id : null;
  const sshListed = environments?.some(
    (item) => item.profile.environmentId === savedId,
  );
  const savedIdIsPeer = peerStations.some(
    (peer) => peer.environmentId === savedId,
  );
  // The saved fallback option renders for everything that is not a listed
  // SSH environment — including a preserved peer default, which must stay
  // visible even though it is no longer offered as a new selection.
  const sshOptionListed = sshListed ?? false;
  // `??` would be wrong here: a loaded-but-not-matching SSH list is `false`,
  // not unknown, and must still fall through to the peer list.
  const listed = sshOptionListed || savedIdIsPeer;
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
        {savedId && !sshOptionListed && (
          <option value={savedId}>
            {savedId} —{' '}
            {savedIdIsPeer
              ? 'paired Station (not offered for new threads)'
              : dangling
                ? 'missing saved environment'
                : 'saved environment'}
          </option>
        )}
        {(environments ?? [])
          .filter((item) => item.profile.environmentId)
          .map((item) => (
            <option key={item.profile.id} value={item.profile.environmentId!}>
              {item.profile.name}
            </option>
          ))}
      </select>
      {savedIdIsPeer && (
        <p
          className="editor-field-hint environment-picker__notice"
          role="status"
        >
          {PEER_DEFAULT_UNSUPPORTED_NOTICE}
        </p>
      )}
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
