import {
  describeDeviceGrant,
  requestedScopeTokens,
} from '@kontourai/station-connect';
import type { MintedPersonalAccessToken } from '@kontourai/station-contracts/personal-tokens';
import {
  STATION_GROUP_LABELS,
  STATION_GROUPS,
  type StationGroup,
  type StationPerson,
  type StationPersonDevice,
} from '@kontourai/station-contracts/station-groups';
import {
  isOperatorCredentialRequired,
  isStationAccessUnavailable,
  type PersonalTokenInput,
  STATION_PEOPLE_QUERY_KEY,
  StationAccessError,
  useMintStationPersonTokenMutation,
  useRevokeStationPersonTokenMutation,
  useSetStationPersonGroupMutation,
  useStationPeopleQuery,
} from '@kontourai/station-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { Empty, ErrorState } from '../../components/state';
import { errorText, userFacingErrorMessage } from '../../utils/errorText';
import {
  OPERATOR_CREDENTIAL_REQUIRED_MESSAGE,
  PersonalTokens,
  SecretOnce,
  sameScope,
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

/** A refused group change, said as what to do next. */
export function groupChangeMessage(error: unknown): string {
  if (isOperatorCredentialRequired(error))
    return OPERATOR_CREDENTIAL_REQUIRED_MESSAGE;
  if (error instanceof StationAccessError) {
    switch (error.code) {
      case 'invalid_group':
        return 'Station didn’t recognise that group. Reload and try again.';
      case 'invalid_principal':
        return 'This person can’t be placed in a group.';
      case 'groups_unavailable':
        return 'Groups can’t be changed on this Station right now. Try again in a moment.';
    }
  }
  return userFacingErrorMessage(error);
}

/** `describeDeviceGrant` is phrased for a sentence; here it stands alone. */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface HeldSecret {
  principalId: string;
  displayName: string;
  minted: MintedPersonalAccessToken;
}

export function PeopleSection() {
  const people = useStationPeopleQuery();
  const mintMutation = useMintStationPersonTokenMutation();
  // Held HERE, above the list query: a refetch that fails or is refused after
  // the mint must not take the only copy of the secret with it.
  const [held, setHeld] = useState<HeldSecret | null>(null);
  const refused = isStationAccessUnavailable(people.error);
  if (refused && !held) return null;
  // The heading is a claim that the caller administers people; it waits for
  // the server's answer rather than appearing and being taken back.
  if (people.isPending && !held) return null;

  const list = refused ? undefined : people.data;
  const heldInList =
    held !== null &&
    (list ?? []).some((person) => person.principalId === held.principalId);

  async function mint(person: StationPerson, input: PersonalTokenInput) {
    try {
      const minted = await mintMutation.mutateAsync({
        principalId: person.principalId,
        ...input,
      });
      setHeld({
        principalId: person.principalId,
        displayName: person.displayName,
        minted,
      });
    } finally {
      // The mutation must not keep the answer (and its secret) once captured.
      mintMutation.reset();
    }
  }

  return (
    <SettingsSection icon="◎" title="People" id="section-people">
      <div {...settingsRow('people')} tabIndex={-1} className="people">
        <div className="people__intro">
          <p>
            A person’s group caps what every device tied to them may do, and
            their access tokens never exceed it. The operator is never capped.
          </p>
          <details className="people__groups-help">
            <summary>What each group allows</summary>
            <dl>
              {STATION_GROUPS.map((group) => (
                <div key={group}>
                  <dt>{STATION_GROUP_LABELS[group].label}</dt>
                  <dd>{STATION_GROUP_LABELS[group].summary}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
        {held && !heldInList && (
          <SecretOnce
            minted={held.minted}
            ownerLabel={held.displayName}
            onDone={() => setHeld(null)}
          />
        )}
        {list === undefined ? (
          people.isError && !refused ? (
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
          ) : null
        ) : (
          <>
            {people.isError && !refused && (
              <p className="people__error" role="alert">
                The list couldn’t be refreshed: {errorText(people.error)}
              </p>
            )}
            {list.length === 0 ? (
              <Empty
                variant="compact"
                label="No one else has a device tied to them yet."
                description="A device is tied to its person when you approve it with their verified identity or account."
              />
            ) : (
              list.map((person) => (
                <PersonCard
                  key={person.principalId}
                  person={person}
                  minted={
                    held?.principalId === person.principalId
                      ? held.minted
                      : null
                  }
                  mint={(input) => mint(person, input)}
                  onDone={() => setHeld(null)}
                />
              ))
            )}
          </>
        )}
      </div>
    </SettingsSection>
  );
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
    <li className="people__row">
      <div className="people__row-text">
        <span className="people__row-name">{device.name}</span>
        <span className="people__meta">
          {effective.length > 0
            ? capitalize(describeDeviceGrant(effective))
            : 'No access its group allows'}
        </span>
      </div>
      {limited && (
        <span className="people__badge">
          Limited by {STATION_GROUP_LABELS[group].label} group
        </span>
      )}
    </li>
  );
}

function PersonCard({
  person,
  minted,
  mint,
  onDone,
}: {
  person: StationPerson;
  minted: MintedPersonalAccessToken | null;
  mint: (input: PersonalTokenInput) => Promise<void>;
  onDone: () => void;
}) {
  const client = useQueryClient();
  const setGroup = useSetStationPersonGroupMutation();
  const revoke = useRevokeStationPersonTokenMutation();
  const [groupError, setGroupError] = useState<string | null>(null);
  const [groupNotice, setGroupNotice] = useState<string | null>(null);
  const [pendingDemotion, setPendingDemotion] = useState<StationGroup | null>(
    null,
  );
  const id = useId();
  const groupLabel = STATION_GROUP_LABELS[person.group].label;

  async function applyGroup(group: StationGroup) {
    setGroupError(null);
    setGroupNotice(null);
    try {
      const change = await setGroup.mutateAsync({
        principalId: person.principalId,
        group,
      });
      // Show the server's answer now; the invalidation refetch confirms it.
      client.setQueriesData<StationPerson[]>(
        { queryKey: STATION_PEOPLE_QUERY_KEY },
        (current) =>
          current?.map((entry) =>
            entry.principalId === change.person.principalId
              ? change.person
              : entry,
          ),
      );
      const reset = Object.keys(change.revocations).length;
      if (reset > 0)
        setGroupNotice(
          `Full access was reset on ${reset} device${reset === 1 ? '' : 's'}.`,
        );
    } catch (cause) {
      setGroupError(groupChangeMessage(cause));
    } finally {
      setPendingDemotion(null);
    }
  }

  function chooseGroup(group: StationGroup) {
    if (group === person.group) return;
    // A demotion takes access away from live devices: ask first.
    if (person.group === 'admin' && group !== 'admin') {
      setPendingDemotion(group);
      return;
    }
    void applyGroup(group);
  }

  return (
    <article
      className="people__person"
      aria-labelledby={`${id}-name`}
      data-principal-id={person.principalId}
    >
      <header className="people__person-header">
        <div className="people__person-id">
          <h4 className="people__person-name" id={`${id}-name`}>
            {person.displayName}
          </h4>
          <span className="people__principal">{person.principalId}</span>
        </div>
        <select
          className="editor-select people__group-select"
          value={person.group}
          disabled={setGroup.isPending}
          aria-label={`Group for ${person.displayName}`}
          title={STATION_GROUP_LABELS[person.group].summary}
          onChange={(event) => chooseGroup(event.target.value as StationGroup)}
        >
          {STATION_GROUPS.map((group) => (
            <option key={group} value={group}>
              {STATION_GROUP_LABELS[group].label}
            </option>
          ))}
        </select>
      </header>
      {groupError && (
        <p className="people__error" role="alert">
          {groupError}
        </p>
      )}
      <p className="people__meta people__notice" role="status">
        {groupNotice ?? ''}
      </p>

      <section className="people__sub" aria-labelledby={`${id}-devices`}>
        <div className="people__sub-header">
          <h5 className="people__sub-title" id={`${id}-devices`}>
            Devices
          </h5>
        </div>
        {person.devices.length === 0 ? (
          <p className="people__meta people__empty">
            No device is tied to them right now.
          </p>
        ) : (
          <ul
            className="people__rows"
            aria-label={`Devices for ${person.displayName}`}
          >
            {person.devices.map((device) => (
              <DeviceRow key={device.id} device={device} group={person.group} />
            ))}
          </ul>
        )}
      </section>

      <PersonalTokens
        heading="Access tokens"
        tokens={person.tokens}
        ownerLabel={person.displayName}
        limitedBy={groupLabel}
        canMint={person.canHoldTokens}
        cannotMintReason="No device ties them by a Tailscale identity, and tokens work only for people tied that way."
        minted={minted}
        mint={mint}
        onDone={onDone}
        revoke={(token) =>
          revoke.mutateAsync({
            principalId: person.principalId,
            tokenId: token.id,
          })
        }
      />

      <ConfirmModal
        isOpen={pendingDemotion !== null}
        title={`Move ${person.displayName} to ${
          pendingDemotion ? STATION_GROUP_LABELS[pendingDemotion].label : ''
        }?`}
        message="Their devices reconnect under the new group, and any full access those devices had granted is reset."
        confirmLabel="Move"
        variant="danger"
        role="alertdialog"
        pending={setGroup.isPending}
        onConfirm={() => {
          if (pendingDemotion) void applyGroup(pendingDemotion);
        }}
        onCancel={() => setPendingDemotion(null)}
      />
    </article>
  );
}
