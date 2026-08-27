import type { PairedDevice } from '@kontourai/station-contracts';
import type { PairingScope } from '@kontourai/station-contracts/environment-security';
import { useCallback, useEffect, useRef, useState } from 'react';
import { deviceRevokeError } from '../../core/deviceActivity';
import { PairedDeviceList } from './PairedDeviceList';

/**
 * Poll cadence for the device registry. `lastUsedAt` is what makes a device
 * read as active, so the list has to be re-fetched for that label to mean
 * anything — ticking a local clock against stale data would decay "Active" into
 * a false "Last used 4 minutes ago" for a device that never stopped working.
 */
const REFRESH_INTERVAL_MS = 15_000;

/**
 * Reviewing which devices can reach a Station, as its own destination.
 *
 * The registry was previously visible only inside the host pairing flow — a
 * flow entered to *grant* access — so auditing or revoking access meant first
 * opening the screen for handing it out. This is the review surface: it answers
 * "who can reach this host, when did they last use it, and how do I turn one
 * off" without offering a new credential along the way.
 */
export function PairedDevicesPanel({
  apiBase,
  getCredential,
  request = fetch,
  allowManualCredentials = true,
  hostAppName,
  onPairDevice,
  onBack,
}: {
  apiBase: string;
  getCredential: () => string | undefined;
  request?: typeof fetch;
  /** Native hosts retain bearer values and authenticate requests themselves. */
  allowManualCredentials?: boolean;
  /** Native host name used for credential-management guidance. */
  hostAppName?: string;
  onPairDevice: () => void;
  onBack: () => void;
}) {
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [operatorCredential, setOperatorCredential] = useState('');
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const busyIdsRef = useRef(new Set<string>());
  const generation = useRef(0);

  const authenticatedFetch = useCallback(
    (path: string, init: RequestInit = {}) => {
      const credential = allowManualCredentials ? getCredential() : undefined;
      return request(new URL(path, apiBase), {
        ...init,
        headers: {
          ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
          ...init.headers,
        },
      });
    },
    [allowManualCredentials, apiBase, getCredential, request],
  );

  // Pairing credentials deliberately cannot administer the pairing family.
  // Keep an operator credential entered for this one management action in
  // component state only; it is neither persisted nor used for inventory reads.
  const deviceAdminFetch = useCallback(
    (path: string, init: RequestInit = {}) => {
      const credential = allowManualCredentials
        ? operatorCredential.trim() || getCredential()
        : undefined;
      return request(new URL(path, apiBase), {
        ...init,
        headers: {
          ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
          ...init.headers,
        },
      });
    },
    [
      allowManualCredentials,
      apiBase,
      getCredential,
      operatorCredential,
      request,
    ],
  );

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const response = await authenticatedFetch('/api/pairing/devices');
      if (current !== generation.current) return;
      if (!response.ok) {
        setLoadError(
          response.status === 401
            ? "This device's access to this Station needs review. Reconnect it, then try again."
            : `This Station could not list its paired devices (HTTP ${response.status}).`,
        );
        return;
      }
      const body = (await response.json()) as { devices?: PairedDevice[] };
      if (current !== generation.current) return;
      setDevices(body.devices ?? []);
      setLoadError(null);
    } catch {
      if (current !== generation.current) return;
      setLoadError('This Station could not be reached. Check the connection.');
    } finally {
      if (current === generation.current) setNow(Date.now());
    }
  }, [authenticatedFetch]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      generation.current += 1;
    };
  }, [refresh]);

  /**
   * station#3816: apply a new scope to a device. Same authority and error
   * shape as revoking — this is the same class of decision (what a device
   * may do here), so it must not be easier to reach than revoke is.
   */
  const changeScope = useCallback(
    async (
      device: PairedDevice,
      scope: PairingScope[],
      expectedScope: string,
    ) => {
      if (busyIdsRef.current.has(device.id)) return;
      setActionError(null);
      busyIdsRef.current.add(device.id);
      setBusyIds(new Set(busyIdsRef.current));
      try {
        const response = await deviceAdminFetch(
          `/api/pairing/devices/${device.id}/scope`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scope, expectedScope }),
          },
        );
        if (!response.ok) {
          setActionError(
            response.status === 401
              ? allowManualCredentials
                ? 'Changing a device’s access requires this Station’s operator credential. Enter it below and try again.'
                : `Changing a device’s access requires the operator credential managed by ${hostAppName ?? 'this native host'}. Update it there, then try again.`
              : response.status === 409
                ? `“${device.name}” was changed somewhere else while this was open. Nothing was applied — reopen it to see its current access.`
                : `This Station refused the access change (HTTP ${response.status}). The device keeps its current access.`,
          );
          return;
        }
        await refresh();
      } catch {
        setActionError(
          `This Station could not change access for “${device.name}”. Check the connection — its current access is unchanged.`,
        );
      } finally {
        busyIdsRef.current.delete(device.id);
        setBusyIds(new Set(busyIdsRef.current));
      }
    },
    [allowManualCredentials, deviceAdminFetch, hostAppName, refresh],
  );

  const revoke = useCallback(
    async (device: PairedDevice) => {
      if (busyIdsRef.current.has(device.id)) return;
      setActionError(null);
      busyIdsRef.current.add(device.id);
      setBusyIds(new Set(busyIdsRef.current));
      try {
        const response = await deviceAdminFetch(
          `/api/pairing/devices/${device.id}`,
          { method: 'DELETE' },
        );
        if (!response.ok) {
          setActionError(
            response.status === 401
              ? allowManualCredentials
                ? 'Revoking a device requires this Station’s operator credential. Enter it below and try again.'
                : `Revoking a device requires the operator credential managed by ${hostAppName ?? 'this native host'}. Update it there, then try again.`
              : deviceRevokeError(response.status),
          );
          return;
        }
        await refresh();
      } catch {
        setActionError(
          `This Station could not revoke “${device.name}”. Check the connection, then try again.`,
        );
      } finally {
        busyIdsRef.current.delete(device.id);
        setBusyIds(new Set(busyIdsRef.current));
      }
    },
    [allowManualCredentials, deviceAdminFetch, hostAppName, refresh],
  );

  const removeRevoked = useCallback(
    async (device: PairedDevice) => {
      if (busyIdsRef.current.has(device.id)) return;
      setActionError(null);
      busyIdsRef.current.add(device.id);
      setBusyIds(new Set(busyIdsRef.current));
      try {
        const response = await deviceAdminFetch(
          `/api/pairing/devices/${device.id}/record`,
          { method: 'DELETE' },
        );
        if (!response.ok) {
          setActionError(
            response.status === 401
              ? allowManualCredentials
                ? 'Removing a revoked device record requires this Station’s operator credential. Enter it above and try again.'
                : `Removing a revoked device record requires the operator credential managed by ${hostAppName ?? 'this native host'}. Update it there, then try again.`
              : `This Station could not remove the revoked record for “${device.name}” (HTTP ${response.status}).`,
          );
          return;
        }
        await refresh();
      } catch {
        setActionError(
          `This Station could not remove the revoked record for “${device.name}”. Check the connection, then try again.`,
        );
      } finally {
        busyIdsRef.current.delete(device.id);
        setBusyIds(new Set(busyIdsRef.current));
      }
    },
    [allowManualCredentials, deviceAdminFetch, hostAppName, refresh],
  );

  return (
    <div className="station-connect-panel">
      <p className="station-connect-panel__intro">
        Devices that have been granted access to this Station. Revoking one ends
        its access immediately; it can pair again later.
      </p>

      {allowManualCredentials ? (
        <label className="station-connect-edit__label">
          Operator credential for device changes
          <span className="station-connect-edit__hint">
            Required only to revoke a device or remove its revoked record. It is
            kept for this open panel and is never saved as a paired-device
            credential.
          </span>
          <input
            type="password"
            value={operatorCredential}
            onChange={(event) => setOperatorCredential(event.target.value)}
            placeholder="Paste this Station’s operator credential"
            autoComplete="off"
            aria-label="Operator credential for device changes"
            className="station-connect-input"
          />
        </label>
      ) : (
        <p className="station-connect-edit__hint">
          {hostAppName ?? 'This native host'} manages the operator credential
          for device changes. Revoke and remove actions use its authenticated
          connection without exposing that credential here.
        </p>
      )}

      {devices === null && !loadError ? (
        <p className="station-connect-empty" role="status">
          Loading devices…
        </p>
      ) : loadError ? (
        <div role="alert" className="station-connect-row__meta--warning">
          {loadError}
        </div>
      ) : (
        <PairedDeviceList
          devices={devices ?? []}
          now={now}
          onRevoke={(device) => void revoke(device)}
          onChangeScope={(device, scope, expectedScope) =>
            void changeScope(device, scope, expectedScope)
          }
          onRemoveRevoked={(device) => void removeRevoked(device)}
          busyIds={busyIds}
        />
      )}

      {actionError && (
        <div role="alert" className="station-connect-row__meta--warning">
          {actionError}
        </div>
      )}

      <div className="station-connect-footer">
        <button
          type="button"
          onClick={onPairDevice}
          className="station-connect-btn station-connect-btn--primary"
        >
          Approve another device
        </button>
        <button
          type="button"
          onClick={onBack}
          className="station-connect-btn station-connect-btn--secondary"
        >
          Back
        </button>
      </div>
    </div>
  );
}
