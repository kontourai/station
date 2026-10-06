import type { PairedDevice } from '@kontourai/station-contracts/environment-security';
import {
  StationHttpError,
  usePairedDevicesQuery,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { Button } from '../Button';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import { Empty, ErrorState, SkeletonBlock } from '../state';

function peopleFromDevices(devices: readonly PairedDevice[]) {
  const people = new Map<
    string,
    { key: string; name: string; devices: PairedDevice[] }
  >();
  for (const device of devices) {
    const binding = device.principalBinding;
    if (device.kind !== 'device' || device.revokedAt !== null || !binding)
      continue;
    const account = 'kind' in binding && binding.kind === 'account';
    const key = JSON.stringify(
      account
        ? ['account', binding.issuer, binding.subject]
        : ['tailscale-serve', binding.subject],
    );
    const person = people.get(key);
    if (person) person.devices.push(device);
    else
      people.set(key, {
        key,
        name: account ? binding.displayName : binding.subject,
        devices: [device],
      });
  }
  return [...people.values()];
}

export function StationPeoplePanel() {
  const scope = useHostRequestAuthorityScope();
  const query = usePairedDevicesQuery(scope?.apiBase, {
    requestScope: scope ?? undefined,
    requireRequestScope: true,
    refetchOnMount: 'always',
  });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const people = query.error ? [] : peopleFromDevices(query.data ?? []);
  const profileKey = (personKey: string) =>
    JSON.stringify([scope?.apiBase, scope?.authorityKey, personKey]);
  const selected = people.find(
    (person) => profileKey(person.key) === selectedKey,
  );
  return (
    <section aria-labelledby="station-people-title">
      <h3 id="station-people-title">People paired with this Station</h3>
      <p>
        Profiles use approved person bindings. Connection status reflects open
        Station event streams.
      </p>
      {!scope ? (
        <p>Connect to this Station to view paired profiles.</p>
      ) : query.isLoading ? (
        <SkeletonBlock count={1} label="Loading paired profiles" />
      ) : query.error ? (
        <ErrorState
          variant="compact"
          title="Paired profiles unavailable"
          description={
            query.error instanceof StationHttpError &&
            [401, 403].includes(query.error.status)
              ? 'Pairing-management access is required to view these profiles. Automatic refresh is paused for this connection.'
              : 'This connection could not read the device registry.'
          }
          action={
            <Button size="sm" onClick={() => void query.refetch()}>
              Retry
            </Button>
          }
        />
      ) : people.length === 0 ? (
        <Empty
          variant="compact"
          label="No approved person profiles"
          description="Paired devices without a person binding are managed in Connections."
        />
      ) : (
        <ul className="profile-people-list">
          {people.map((person) => (
            <li key={person.key}>
              <Button onClick={() => setSelectedKey(profileKey(person.key))}>
                {person.name}
              </Button>
              <span>
                {person.devices.length} paired{' '}
                {person.devices.length === 1 ? 'device' : 'devices'}
              </span>
              <span>
                {person.devices.some(
                  (device) => (device.connectedClients?.sessionCount ?? 0) > 0,
                )
                  ? 'Connected event stream'
                  : 'No live connection reported'}
              </span>
            </li>
          ))}
        </ul>
      )}
      {selected && scope && !query.error && (
        <ResponsiveDialogSurface
          layer="dialog"
          onClose={() => setSelectedKey(null)}
          ariaLabel={`${selected.name} paired profile`}
          overlayClassName="profile-person-overlay"
          panelClassName="profile-person-dialog"
        >
          <ResponsiveDialogCloseButton
            onClick={() => setSelectedKey(null)}
            label="Close paired profile"
          />
          <h2>{selected.name}</h2>
          <p>
            Approved devices on this Station. Personal usage statistics are not
            shared here.
          </p>
          <ul className="profile-people-list">
            {selected.devices.map((device) => (
              <li key={device.id}>
                <strong>{device.name}</strong>
                <span>
                  {device.lastUsedAt === undefined
                    ? 'Last authenticated request unknown'
                    : `Last authenticated request ${new Date(device.lastUsedAt).toLocaleString()}`}
                </span>
              </li>
            ))}
          </ul>
        </ResponsiveDialogSurface>
      )}
    </section>
  );
}
