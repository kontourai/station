import {
  describeDeviceGrant,
  requestedScopeTokens,
} from '@kontourai/station-connect';
import {
  STATION_GROUP_LABELS,
  STATION_GROUPS,
  type StationGroup,
  type StationPerson,
  type StationPersonDevice,
} from '@kontourai/station-contracts/station-groups';
import {
  isStationAccessUnavailable,
  STATION_PEOPLE_QUERY_KEY,
  useMintStationPersonTokenMutation,
  useRevokeStationPersonTokenMutation,
  useSetStationPersonGroupMutation,
  useStationPeopleQuery,
} from '@kontourai/station-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { Empty, ErrorState } from '../../components/state';
import { errorText } from '../../utils/errorText';
import {
  PersonalTokens,
  sameScope,
  tokenActionMessage,
} from './PersonalTokens';
import { SettingsSection } from './SettingsSection';
import { settingsRow } from './settings-catalog';
import './PeopleSection.css';

/**
 * Settings › People (#3557): everyone with a device tied to them, the Station
 * group that caps those devices, and their personal access tokens.
 *
 * Operator-only, gated by the SERVER like plugin visibility: the read is
 * admitted for the operator credential and the desktop's local grant, and
 * anything the route refuses (or a Station without the route) renders
 * nothing. Changes need the operator credential itself, so the local grant
 * can list but its changes come back 401 — answered with what to do, not a
 * dead control.
 */
export function PeopleSection() {
  const people = useStationPeopleQuery();
  if (isStationAccessUnavailable(people.error)) return null;
  // The heading is a claim that the caller administers people; it waits for
  // the server's answer rather than appearing and being taken back.
  if (people.isPending) return null;
  return (
    <SettingsSection icon="◎" title="People" id="section-people">
      <div {...settingsRow('people')} tabIndex={-1}>
        <p className="people__intro">
          A person’s group caps what every device tied to them may do, and their
          access tokens never exceed it. The operator is never capped.
        </p>
        {people.isError ? (
          <ErrorState
            variant="compact"
            title="People could not be listed"
            description={errorText(people.error)}
            action={
              <Button size="sm" onClick={() => void people.refetch()}>
                Retry
              </Button>
            }
          />
        ) : people.data.length === 0 ? (
          <Empty
            variant="compact"
            label="No one else has a device tied to them yet."
            description="A device is tied to its person when you approve it with their verified identity or account."
          />
        ) : (
          people.data.map((person) => (
            <PersonCard key={person.principalId} person={person} />
          ))
        )}
      </div>
    </SettingsSection>
  );
}

/** `describeDeviceGrant` is phrased for a sentence; here it stands alone. */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function DeviceRow({
  device,
  group,
}: {
  device: StationPersonDevice;
  group: StationGroup;
}) {
  const limited = !sameScope(device.scope, device.effectiveScope);
  const effective = requestedScopeTokens(device.effectiveScope);
  return (
    <li className="people__item">
      <div className="people__item-text">
        <span className="people__item-name">{device.name}</span>
        <span className="people__meta">
          {effective.length > 0
            ? capitalize(describeDeviceGrant(effective))
            : 'No access its group allows'}
        </span>
        {limited && (
          <span className="people__limited">
            Limited by {STATION_GROUP_LABELS[group].label} group
          </span>
        )}
      </div>
    </li>
  );
}

function PersonCard({ person }: { person: StationPerson }) {
  const client = useQueryClient();
  const setGroup = useSetStationPersonGroupMutation();
  const mint = useMintStationPersonTokenMutation();
  const revoke = useRevokeStationPersonTokenMutation();
  const [groupError, setGroupError] = useState<string | null>(null);
  const groupId = useId();
  const groupLabel = STATION_GROUP_LABELS[person.group].label;

  async function changeGroup(group: StationGroup) {
    setGroupError(null);
    try {
      const updated = await setGroup.mutateAsync({
        principalId: person.principalId,
        group,
      });
      // Show the server's answer now; the invalidation refetch confirms it.
      client.setQueriesData<StationPerson[]>(
        { queryKey: STATION_PEOPLE_QUERY_KEY },
        (current) =>
          current?.map((entry) =>
            entry.principalId === updated.principalId ? updated : entry,
          ),
      );
    } catch (cause) {
      setGroupError(tokenActionMessage(cause));
    }
  }

  return (
    <article
      className="people__person"
      aria-labelledby={`${groupId}-name`}
      data-principal-id={person.principalId}
    >
      <header className="people__person-header">
        <div className="people__item-text">
          <h4 className="people__person-name" id={`${groupId}-name`}>
            {person.displayName}
          </h4>
          <span className="people__meta people__principal">
            {person.principalId}
          </span>
        </div>
        <label className="people__group" htmlFor={groupId}>
          <span className="people__field-label">Group</span>
          <select
            id={groupId}
            className="editor-select"
            value={person.group}
            disabled={setGroup.isPending}
            aria-label={`Group for ${person.displayName}`}
            onChange={(event) =>
              void changeGroup(event.target.value as StationGroup)
            }
          >
            {STATION_GROUPS.map((group) => (
              <option key={group} value={group}>
                {STATION_GROUP_LABELS[group].label}
              </option>
            ))}
          </select>
        </label>
      </header>
      <p className="people__meta people__group-summary">
        {STATION_GROUP_LABELS[person.group].summary}
      </p>
      {groupError && (
        <p className="people__error" role="alert">
          {groupError}
        </p>
      )}

      <h5 className="people__subheading">Devices</h5>
      {person.devices.length === 0 ? (
        <p className="people__meta">No device is tied to them right now.</p>
      ) : (
        <ul
          className="people__list"
          aria-label={`Devices for ${person.displayName}`}
        >
          {person.devices.map((device) => (
            <DeviceRow key={device.id} device={device} group={person.group} />
          ))}
        </ul>
      )}

      <h5 className="people__subheading">Access tokens</h5>
      <PersonalTokens
        tokens={person.tokens}
        ownerLabel={person.displayName}
        limitedBy={groupLabel}
        canMint={person.canHoldTokens}
        cannotMintReason="No device ties them by a Tailscale identity, and tokens work only for people tied that way."
        mint={(input) =>
          mint.mutateAsync({ principalId: person.principalId, ...input })
        }
        revoke={(token) =>
          revoke.mutateAsync({
            principalId: person.principalId,
            tokenId: token.id,
          })
        }
      />
    </article>
  );
}
