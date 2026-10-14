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
import { useCallback, useEffect, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { PersonList } from '../../components/people/PersonList';
import { PersonRow } from '../../components/people/PersonRow';
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
function groupChangeMessage(error: unknown): string {
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

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function limitedDevices(person: StationPerson): number {
  return person.devices.filter(
    (device) => !sameScope(device.scope, device.effectiveScope),
  ).length;
}

/** `needle` arrives trimmed and lower-cased. */
function matchesFilter(person: StationPerson, needle: string): boolean {
  return (
    person.displayName.toLowerCase().includes(needle) ||
    person.principalId.toLowerCase().includes(needle)
  );
}

export function PeopleSection() {
  const people = useStationPeopleQuery();
  const mintMutation = useMintStationPersonTokenMutation();
  // Held HERE, above the list query: a refetch that fails or is refused after
  // the mint must not take the only copy of the secret with it.
  const [held, setHeld] = useState<HeldSecret | null>(null);
  // Which people the reader opened or closed. Local UI state only: an absent
  // entry follows the default (open when there is exactly one person).
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  // Who opened by themselves, decided ONCE, when the list first arrives:
  // re-deriving it each render would close the only person the moment a
  // refetch added a second one, under whatever they had open.
  const [autoOpen, setAutoOpen] = useState<string | null | undefined>(
    undefined,
  );
  if (autoOpen === undefined && people.data)
    setAutoOpen(
      people.data.length === 1 ? (people.data[0]?.principalId ?? null) : null,
    );
  // People whose row has a form, a revoke confirmation or a revoke in
  // flight: kept visible through a filter, like the held secret's owner.
  const [busyRows, setBusyRows] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const setRowBusy = useCallback((principalId: string, busy: boolean) => {
    setBusyRows((current) => {
      if (current.has(principalId) === busy) return current;
      const next = new Set(current);
      if (busy) next.add(principalId);
      else next.delete(principalId);
      return next;
    });
  }, []);
  const [filter, setFilter] = useState('');
  // After Done on a secret shown apart from its row, focus lands on the
  // section rather than on the document body.
  const [focusSection, setFocusSection] = useState(false);
  useEffect(() => {
    if (!focusSection) return;
    document.getElementById('section-people')?.focus();
    setFocusSection(false);
  }, [focusSection]);
  const refused = isStationAccessUnavailable(people.error);
  if (refused && !held) return null;
  // The heading is a claim that the caller administers people; it waits for
  // the server's answer rather than appearing and being taken back.
  if (people.isPending && !held) return null;

  const list = refused ? undefined : people.data;
  // The held secret's owner is pinned through the filter (below), so they
  // are shown in the list exactly when they are in it.
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
    <SettingsSection icon="◐" title="People" id="section-people">
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
            onDone={() => {
              setHeld(null);
              setFocusSection(true);
            }}
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
            <PersonList
              items={list}
              itemKey={(person) => person.principalId}
              label="People"
              empty={
                <Empty
                  variant="compact"
                  label="Nothing here yet"
                  description="When you approve a device with its person’s verified identity or account, that person appears here."
                />
              }
              filter={{
                value: filter,
                onChange: setFilter,
                placeholder: 'Name or principal id',
                matches: matchesFilter,
                // The person holding an unshown secret, or with a token
                // action under way, is never filtered away.
                pinned: (person) =>
                  held?.principalId === person.principalId ||
                  busyRows.has(person.principalId),
              }}
              renderItem={(person) => (
                <PersonCard
                  person={person}
                  open={
                    toggled[person.principalId] ??
                    autoOpen === person.principalId
                  }
                  onToggle={(open) =>
                    setToggled((current) => ({
                      ...current,
                      [person.principalId]: open,
                    }))
                  }
                  minted={
                    held?.principalId === person.principalId
                      ? held.minted
                      : null
                  }
                  mint={(input) => mint(person, input)}
                  onDone={() => setHeld(null)}
                  onBusyChange={setRowBusy}
                  // One secret at a time: a second mint would replace the
                  // one still waiting to be copied.
                  {...(held && held.principalId !== person.principalId
                    ? {
                        newDisabledReason:
                          'Finish with the token that is showing first.',
                      }
                    : {})}
                />
              )}
            />
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
  open: wantsOpen,
  onToggle,
  minted,
  mint,
  onDone,
  onBusyChange,
  newDisabledReason,
}: {
  person: StationPerson;
  onBusyChange: (principalId: string, busy: boolean) => void;
  newDisabledReason?: string;
  /** What the reader (or the default) asked for. */
  open: boolean;
  onToggle: (open: boolean) => void;
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
  const [editing, setEditing] = useState(false);
  const principalId = person.principalId;
  const onEditingChange = useCallback(
    (next: boolean) => {
      setEditing(next);
      onBusyChange(principalId, next);
    },
    [onBusyChange, principalId],
  );
  const id = useId();
  const groupLabel = STATION_GROUP_LABELS[person.group].label;
  const pinned = editing || minted !== null;
  const limited = limitedDevices(person);

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
        setGroupNotice(`Full access was reset on ${plural(reset, 'device')}.`);
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
    <PersonRow
      principalId={person.principalId}
      name={person.displayName}
      meta={
        <>
          {plural(person.devices.length, 'device')} ·{' '}
          {plural(person.tokens.length, 'token')}
          {limited > 0 && (
            <span className="people__attention">
              <span className="people__attention-dot" aria-hidden="true" />
              {limited} limited
            </span>
          )}
        </>
      }
      open={wantsOpen}
      onToggle={onToggle}
      // A New token form or an unshown secret pins the person open:
      // collapsing would unmount the form, or hide the only copy of the
      // secret.
      pinned={pinned}
      pinnedReason="Finish the new token first"
      actions={
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
      }
      status={
        <>
          {groupError && (
            <p className="people__error" role="alert">
              {groupError}
            </p>
          )}
          <p className="people__meta people__notice" role="status">
            {groupNotice ?? ''}
          </p>
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
        </>
      }
      body={
        <>
          <span className="people__principal">{person.principalId}</span>
          <section className="people__sub" aria-labelledby={`${id}-devices`}>
            <div className="people__sub-header">
              <h5 className="people__sub-title" id={`${id}-devices`}>
                Devices
              </h5>
            </div>
            {person.devices.length === 0 ? (
              <Empty
                className="people__none"
                label="None tied to them right now."
              />
            ) : (
              <ul
                className="people__rows"
                aria-label={`Devices for ${person.displayName}`}
              >
                {person.devices.map((device) => (
                  <DeviceRow
                    key={device.id}
                    device={device}
                    group={person.group}
                  />
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
            onEditingChange={onEditingChange}
            {...(newDisabledReason ? { newDisabledReason } : {})}
            revoke={(token) =>
              revoke.mutateAsync({
                principalId: person.principalId,
                tokenId: token.id,
              })
            }
          />
        </>
      }
    />
  );
}
