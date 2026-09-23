import {
  openDeviceConnectionTrustStore,
  type StationRelayRouteTrustStatus,
  stationRelayRouteTrustStatus,
} from '@kontourai/station-connect/connection-trust';
import type { StationProfile } from '@kontourai/station-contracts';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { SkeletonBlock } from '../../components/state';
import { nativeProfileRepository } from '../../platform/PlatformProfileContext';

const RELAY_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type RelayTrustStatus =
  | StationRelayRouteTrustStatus
  | 'invalid'
  | 'checking'
  | 'unavailable';

const TRUST_COPY: Record<
  Exclude<RelayTrustStatus, 'checking'>,
  { label: string; detail: string }
> = {
  invalid: {
    label: 'Station identifiers invalid',
    detail:
      'Station ID and enrollment ID must be the UUIDs supplied for this Station enrollment.',
  },
  unavailable: {
    label: 'Trust unavailable',
    detail:
      'This device’s trust store is unavailable. The route remains untrusted.',
  },
  untrusted: {
    label: 'Station not trusted',
    detail:
      'No approved Station key is stored for this ID on this device. The route remains untrusted.',
  },
  revoked: {
    label: 'Trust revoked',
    detail:
      'This device has revoked trust for the selected Station enrollment.',
  },
  mismatch: {
    label: 'Station identity mismatch',
    detail: 'The approved Station key belongs to a different enrollment.',
  },
  approved: {
    label: 'Station trust approved',
    detail:
      'This exact Station enrollment has an independently approved key on this device.',
  },
};

function routeTrustStatus(
  validIds: boolean,
  query: { isPending: boolean; isError: boolean },
): RelayTrustStatus | undefined {
  if (!validIds) return 'invalid';
  if (query.isPending) return 'checking';
  if (query.isError) return 'unavailable';
}

function profileSaveOptions(profile?: StationProfile) {
  if (!profile) return {};
  return {
    connectionId: `station-profile:${profile.name.toLowerCase()}`,
    expectedUpdatedAt: profile.updatedAt,
  };
}

function relaySaveErrorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return 'Could not save relay route.';
}

function useRouteTrust(stationId: string, enrollmentId: string) {
  const validIds =
    RELAY_ID.test(stationId.trim()) && RELAY_ID.test(enrollmentId.trim());
  const query = useQuery({
    queryKey: ['relay-route-trust', stationId],
    enabled: validIds,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const store = await openDeviceConnectionTrustStore();
      try {
        return await store.read(stationId.trim());
      } finally {
        store.close();
      }
    },
  });

  const status =
    routeTrustStatus(validIds, query) ??
    stationRelayRouteTrustStatus(query.data ?? null, {
      stationId: stationId.trim(),
      enrollmentId: enrollmentId.trim(),
    });
  return {
    status,
    detail: status === 'checking' ? '' : TRUST_COPY[status].detail,
  };
}

export function RelayRouteTrustReadout({
  stationId,
  enrollmentId,
}: {
  stationId: string;
  enrollmentId: string;
}) {
  const { status, detail } = useRouteTrust(stationId, enrollmentId);
  if (status === 'checking')
    return (
      <SkeletonBlock
        count={1}
        label="Checking Station trust"
        className="relay-route-trust relay-route-trust--checking"
      />
    );
  return (
    <div
      className={`relay-route-trust relay-route-trust--${status}`}
      role="status"
      aria-label={`Station trust: ${status}`}
    >
      <strong>{TRUST_COPY[status].label}</strong>
      <span>{detail}</span>
    </div>
  );
}

export function RelayRouteProfileDialog({
  profile,
  onClose,
}: {
  profile?: StationProfile;
  onClose: () => void;
}) {
  const fieldId = useId();
  const [name, setName] = useState(profile?.name ?? '');
  const [endpoint, setEndpoint] = useState(profile?.endpoint ?? '');
  const [brokerOrigin, setBrokerOrigin] = useState(
    profile?.relayRoute?.brokerOrigin ?? '',
  );
  const [stationId, setStationId] = useState(
    profile?.relayRoute?.stationId ?? '',
  );
  const [enrollmentId, setEnrollmentId] = useState(
    profile?.relayRoute?.enrollmentId ?? '',
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    setError(null);
    setSaving(true);
    try {
      await nativeProfileRepository().saveRelayRouteProfile({
        ...profileSaveOptions(profile),
        name,
        endpoint,
        relayRoute: { brokerOrigin, stationId, enrollmentId },
      });
      onClose();
    } catch (cause) {
      setError(relaySaveErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      eyebrow="Station route"
      title={profile ? 'Edit broker route' : 'Save broker route'}
      subtitle="A broker finds the Station. It does not authenticate this device or grant Project access."
      closeLabel="Close broker route"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={saving}
            pending={saving}
            pendingLabel="Saving…"
            onClick={() => void submit()}
          >
            Save route
          </Button>
        </>
      }
    >
      <label className="editor-field" htmlFor={`${fieldId}-station-endpoint`}>
        <span className="editor-label">Station application address</span>
        <input
          id={`${fieldId}-station-endpoint`}
          className="editor-input"
          value={endpoint}
          placeholder="https://station.example"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => setEndpoint(event.target.value)}
        />
        <span className="editor-hint">
          The Station’s application origin is entered separately from the
          broker.
        </span>
      </label>
      <label className="editor-field" htmlFor={`${fieldId}-broker-origin`}>
        <span className="editor-label">Broker address</span>
        <input
          id={`${fieldId}-broker-origin`}
          className="editor-input"
          value={brokerOrigin}
          placeholder="https://broker.example"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => setBrokerOrigin(event.target.value)}
        />
        <span className="editor-hint">
          Public brokers require HTTPS. HTTP is allowed only for a numeric
          loopback address during local testing.
        </span>
      </label>
      <label className="editor-field" htmlFor={`${fieldId}-station-id`}>
        <span className="editor-label">Station ID</span>
        <input
          id={`${fieldId}-station-id`}
          className="editor-input"
          value={stationId}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => setStationId(event.target.value)}
        />
      </label>
      <label className="editor-field" htmlFor={`${fieldId}-enrollment-id`}>
        <span className="editor-label">Enrollment ID</span>
        <input
          id={`${fieldId}-enrollment-id`}
          className="editor-input"
          value={enrollmentId}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => setEnrollmentId(event.target.value)}
        />
      </label>
      <RelayRouteTrustReadout
        stationId={stationId}
        enrollmentId={enrollmentId}
      />
      <p className="connections-computers__note">
        The profile stores no broker credential or Station signing key. The key
        is read only from this device’s separate trust record. This trust
        display is advisory; a connection attempt must check the current record
        again. Saving this route does not connect or sign in; broker transport
        and account setup are not enabled here.
      </p>
      <label className="editor-field" htmlFor={`${fieldId}-name`}>
        <span className="editor-label">
          Name <span className="editor-hint">optional</span>
        </span>
        <input
          id={`${fieldId}-name`}
          className="editor-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {error && (
        <p className="connections-computers__alert" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
