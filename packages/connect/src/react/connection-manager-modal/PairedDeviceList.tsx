import type { PairedDevice } from '@kontourai/station-contracts';
import type { PairingScope } from '@kontourai/station-contracts/environment-security';
import { useState } from 'react';
import {
  describeDelegationStanding,
  describeDeviceActivity,
  describeDeviceProvenance,
  describeDeviceRevocation,
  describeDeviceScope,
  partitionPairedDevices,
} from '../../core/deviceActivity';
import { DeviceScopeEditor } from './DeviceScopeEditor';

interface PairedDeviceListProps {
  devices: readonly PairedDevice[];
  /** Passed in rather than read here so labels re-render on the owner's tick. */
  now: number;
  onRevoke: (device: PairedDevice) => void;
  onRemoveRevoked: (device: PairedDevice) => void;
  /** station#3816: apply a new scope to a live device. */
  onChangeScope: (
    device: PairedDevice,
    scope: PairingScope[],
    expectedScope: string,
  ) => void;
  /** Devices with a mutation in flight; their controls stay disabled. */
  busyIds: ReadonlySet<string>;
  /** Rendered in place of the list when the host has no devices at all. */
  emptyMessage?: string;
}

function DeviceRow({
  device,
  now,
  onRevoke,
  onRemoveRevoked,
  onChangeScope,
  busy,
}: {
  device: PairedDevice;
  now: number;
  onRevoke: (device: PairedDevice) => void;
  onRemoveRevoked: (device: PairedDevice) => void;
  onChangeScope: (
    device: PairedDevice,
    scope: PairingScope[],
    expectedScope: string,
  ) => void;
  busy: boolean;
}) {
  // Revoking is destructive and security-relevant, so it takes two deliberate
  // clicks. An inline confirm rather than window.confirm: a native dialog
  // blocks the page, and the repo's own guidance rules it out for prompts.
  const [confirming, setConfirming] = useState(false);
  // station#3816: the scope editor and the revoke confirm are mutually
  // exclusive — one question at a time in a row this small.
  const [editingScope, setEditingScope] = useState(false);
  const activity = describeDeviceActivity(device, now);
  const provenance = describeDeviceProvenance(device);
  const revocation = describeDeviceRevocation(device);
  // station#3845: what this device can delegate NOW, not what it was minted
  // for — its scope is editable, so the claim has to be re-derived.
  const delegation = describeDelegationStanding(device);

  return (
    <div className="station-connect-row station-connect-row--static">
      <div className="station-connect-row__body">
        <div className="station-connect-row__name-line">
          <div className="station-connect-row__name">{device.name}</div>
          {delegation && (
            <span className="station-connect-chip" title={delegation.title}>
              {delegation.label}
            </span>
          )}
          {device.connectedClients && (
            <span className="station-connect-chip">
              Connected now
              {device.connectedClients.sessionCount > 1
                ? ` · ${device.connectedClients.sessionCount}`
                : ''}
            </span>
          )}
          {!device.connectedClients && activity.recentlyActive && (
            <span className="station-connect-chip">Active recently</span>
          )}
          {device.revokedAt === null && !device.connectedClients && (
            <span className="station-connect-chip">Has access</span>
          )}
        </div>
        <div className="station-connect-row__meta">
          {describeDeviceScope(device.scope)} · {activity.pairedLabel}
          {provenance ? ` · ${provenance}` : ''}
        </div>
        <div className="station-connect-row__meta">
          {activity.revokedLabel ??
            (device.connectedClients
              ? `Connected now${device.connectedClients.sessionCount > 1 ? ` · ${device.connectedClients.sessionCount} sessions` : ''}`
              : activity.recentlyActive
                ? 'Recent request activity'
                : activity.lastUsedLabel)}
          {revocation ? ` · ${revocation}` : ''}
        </div>
      </div>
      {device.revokedAt === null ? (
        <div className="station-connect-row__actions station-connect-row__actions--static">
          {confirming ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  onRevoke(device);
                }}
                className="station-connect-btn station-connect-btn--danger station-connect-btn--inline"
              >
                Confirm
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(false)}
                className="station-connect-btn station-connect-btn--secondary station-connect-btn--inline"
              >
                Cancel
              </button>
            </>
          ) : editingScope ? null : (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditingScope(true)}
                aria-label={`Change access for ${device.name}`}
                className="station-connect-btn station-connect-btn--secondary station-connect-btn--inline"
              >
                Change access
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(true)}
                aria-label={`Revoke ${device.name}`}
                className="station-connect-btn station-connect-btn--secondary station-connect-btn--inline"
              >
                Revoke
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="station-connect-row__actions station-connect-row__actions--static">
          <button
            type="button"
            disabled={busy}
            onClick={() => onRemoveRevoked(device)}
            aria-label={`Remove revoked record for ${device.name}`}
            className="station-connect-btn station-connect-btn--secondary station-connect-btn--inline"
          >
            Remove record
          </button>
        </div>
      )}
      {editingScope && device.revokedAt === null && (
        <DeviceScopeEditor
          deviceName={device.name}
          currentScope={device.scope}
          busy={busy}
          onApply={(scope, expectedScope) => {
            setEditingScope(false);
            onChangeScope(device, scope, expectedScope);
          }}
          onCancel={() => setEditingScope(false)}
        />
      )}
    </div>
  );
}

/**
 * The paired devices of one Station host, split into what still has access and
 * what has been turned off.
 *
 * Shared by the host pairing flow and the standalone devices panel so the two
 * cannot drift into showing different things about the same registry.
 */
export function PairedDeviceList({
  devices,
  now,
  onRevoke,
  onRemoveRevoked,
  onChangeScope,
  busyIds,
  emptyMessage = 'No devices are paired with this Station yet.',
}: PairedDeviceListProps) {
  const { active, revoked } = partitionPairedDevices(devices);

  if (devices.length === 0) {
    return <p className="station-connect-empty">{emptyMessage}</p>;
  }

  return (
    <>
      <section
        aria-label="Devices with access"
        className="station-connect-list"
      >
        <strong className="station-connect-section-title">
          Devices with access
        </strong>
        {active.length === 0 ? (
          <p className="station-connect-empty">
            No device currently has access.
          </p>
        ) : (
          active.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              now={now}
              onRevoke={onRevoke}
              onRemoveRevoked={onRemoveRevoked}
              onChangeScope={onChangeScope}
              busy={busyIds.has(device.id)}
            />
          ))
        )}
      </section>

      {revoked.length > 0 && (
        <section aria-label="Revoked devices" className="station-connect-list">
          <strong className="station-connect-section-title">Revoked</strong>
          {revoked.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              now={now}
              onRevoke={onRevoke}
              onRemoveRevoked={onRemoveRevoked}
              onChangeScope={onChangeScope}
              busy={busyIds.has(device.id)}
            />
          ))}
        </section>
      )}
    </>
  );
}
