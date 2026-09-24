import {
  openDeviceConnectionTrustStore,
  stationRelayRouteTrustStatus,
} from '@kontourai/station-connect/connection-trust';
import type {
  ApprovedStationConnectionTrust,
  DeviceConnectionTrustRecord,
} from '@kontourai/station-contracts/connection-proof';
import {
  copyStationConnectionTrust,
  formatStationConnectionKeyConfirmationCode,
  stationConnectionKeyConfirmationCode,
  stationConnectionSigningKeyId,
} from '@kontourai/station-shared/connection-proof';
import { useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import { SkeletonBlock } from '../../components/state';

const MAX_REPORT_BYTES = 4096;
const REPORT_SCHEMA = 'station.connection-key/v1';
const KEY_ID = /^[A-Za-z0-9_-]{43}$/u;

interface OperatorKeyReport {
  readonly trust: ApprovedStationConnectionTrust;
  readonly keyId: string;
  readonly confirmationCode: string;
}

type TrustDecision = {
  readonly status: 'untrusted' | 'approved' | 'revoked' | 'mismatch';
  readonly label: string;
  readonly detail: string;
  readonly canApprove: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function parseOperatorKeyReport(
  text: string,
): Promise<OperatorKeyReport> {
  if (new TextEncoder().encode(text).byteLength > MAX_REPORT_BYTES)
    throw new Error('The Station key report is too large.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Paste the JSON report from the Station operator.');
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).sort().join(',') !==
      'keyId,operation,schema,status,trust' ||
    parsed.schema !== REPORT_SCHEMA ||
    !['inspect', 'initialize', 'rotate'].includes(String(parsed.operation)) ||
    parsed.status !== 'present' ||
    typeof parsed.keyId !== 'string' ||
    !KEY_ID.test(parsed.keyId)
  )
    throw new Error('This is not a complete Station operator key report.');

  let trust: ApprovedStationConnectionTrust;
  try {
    trust = copyStationConnectionTrust(
      parsed.trust as ApprovedStationConnectionTrust,
    );
  } catch {
    throw new Error('The Station key report is invalid.');
  }
  const keyId = await stationConnectionSigningKeyId(trust);
  if (keyId !== parsed.keyId)
    throw new Error('The Station key ID does not match its public key.');
  const confirmationCode = await stationConnectionKeyConfirmationCode(trust);
  return Object.freeze({ trust, keyId, confirmationCode });
}

function sameKey(
  left: ApprovedStationConnectionTrust,
  right: ApprovedStationConnectionTrust,
) {
  return (
    left.generation === right.generation &&
    left.signingKey.x === right.signingKey.x &&
    left.signingKey.y === right.signingKey.y
  );
}

function sameReviewedTrust(
  reviewed: DeviceConnectionTrustRecord | null,
  current: DeviceConnectionTrustRecord | null,
) {
  if (!reviewed || !current) return reviewed === current;
  return (
    reviewed.revision === current.revision &&
    reviewed.status === current.status &&
    reviewed.trust.stationId === current.trust.stationId &&
    reviewed.trust.enrollmentId === current.trust.enrollmentId &&
    sameKey(reviewed.trust, current.trust)
  );
}

function decideTrust(
  record: DeviceConnectionTrustRecord | null,
  candidate: ApprovedStationConnectionTrust,
): TrustDecision {
  if (!record)
    return {
      status: 'untrusted',
      label: 'No Station key is approved on this browser',
      detail: 'Compare the confirmation code and full key ID with the Station operator.',
      canApprove: true,
    };
  const status = stationRelayRouteTrustStatus(record, candidate);
  if (status === 'mismatch')
    return {
      status,
      label: 'Station enrollment mismatch',
      detail:
        'A different enrollment is already stored for this Station ID. This form cannot reset or replace that enrollment.',
      canApprove: false,
    };
  if (record.status === 'revoked') {
    const rotatedKey =
      candidate.signingKey.x !== record.trust.signingKey.x ||
      candidate.signingKey.y !== record.trust.signingKey.y;
    const canApprove =
      candidate.generation > record.trust.generation && rotatedKey;
    return {
      status: 'revoked',
      label: 'Station trust is revoked',
      detail: canApprove
        ? 'This newer key can restore trust after a separate fingerprint comparison.'
        : 'A revoked key cannot be restored at the same or an older generation. Ask the operator for a higher-generation report with a new signing key.',
      canApprove,
    };
  }
  if (sameKey(record.trust, candidate))
    return {
      status: 'approved',
      label: 'This Station key is already approved',
      detail:
        'The exact enrollment, generation and public key are trusted here.',
      canApprove: false,
    };
  const rotatedKey =
    candidate.signingKey.x !== record.trust.signingKey.x ||
    candidate.signingKey.y !== record.trust.signingKey.y;
  const canApprove =
    candidate.generation > record.trust.generation && rotatedKey;
  return {
    status: canApprove ? 'untrusted' : 'mismatch',
    label: canApprove
      ? 'A newer Station key needs approval'
      : 'Station key generation mismatch',
    detail: canApprove
      ? 'Station signing keys changed. Compare this new key ID independently before approving the rotation.'
      : 'The supplied key does not advance the generation with a new signing key. This form will not replace trust with an older or conflicting key.',
    canApprove,
  };
}

function approvalError(cause: unknown) {
  const code = cause instanceof Error ? cause.message : '';
  if (code === 'device_trust_conflict')
    return 'Station trust changed while you were reviewing it. Check the current operator report and try again.';
  if (code === 'device_trust_unavailable')
    return 'This browser could not durably update its Station trust store.';
  return 'Station key approval was refused. Check the operator report and try again.';
}

/**
 * Station key admission is deliberately separate from broker invitation entry.
 * The operator report is public metadata; only an explicit out-of-band
 * fingerprint comparison can proceed to the device-local trust store.
 */
export function BrowserStationTrustApproval() {
  const [reportText, setReportText] = useState('');
  const [candidate, setCandidate] = useState<OperatorKeyReport | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [record, setRecord] = useState<DeviceConnectionTrustRecord | null>();
  const [recordError, setRecordError] = useState<string | null>(null);
  const [confirmedKeyId, setConfirmedKeyId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setCandidate(null);
    setParseError(null);
    setRecord(undefined);
    setRecordError(null);
    setConfirmedKeyId(null);
    setResult(null);
    if (!reportText.trim()) {
      setRecord(null);
      return () => {
        current = false;
      };
    }

    void (async () => {
      let parsed: OperatorKeyReport;
      try {
        parsed = await parseOperatorKeyReport(reportText.trim());
      } catch (error) {
        if (current)
          setParseError(
            error instanceof Error
              ? error.message
              : 'The Station key report is invalid.',
          );
        return;
      }
      if (!current) return;
      setCandidate(parsed);
      let store: Awaited<
        ReturnType<typeof openDeviceConnectionTrustStore>
      > | null = null;
      try {
        store = await openDeviceConnectionTrustStore();
        const latest = await store.read(parsed.trust.stationId);
        if (current) setRecord(latest);
      } catch {
        if (current)
          setRecordError('This browser’s Station trust store is unavailable.');
      } finally {
        store?.close();
      }
    })();
    return () => {
      current = false;
    };
  }, [reportText]);

  async function approve() {
    if (
      busy ||
      !candidate ||
      confirmedKeyId !== candidate.keyId ||
      record === undefined
    )
      return;
    setBusy(true);
    setRecordError(null);
    setResult(null);
    let store: Awaited<
      ReturnType<typeof openDeviceConnectionTrustStore>
    > | null = null;
    try {
      store = await openDeviceConnectionTrustStore();
      const latest = await store.read(candidate.trust.stationId);
      if (!sameReviewedTrust(record, latest)) {
        setRecord(latest);
        setConfirmedKeyId(null);
        throw new Error('device_trust_conflict');
      }
      const decision = decideTrust(record, candidate.trust);
      if (!decision.canApprove) throw new Error('device_trust_conflict');
      const approved = await store.approve(
        candidate.trust,
        record?.revision ?? null,
        candidate.keyId,
      );
      setRecord(approved);
      setConfirmedKeyId(null);
      setResult('Station signing key approved on this browser.');
    } catch (cause) {
      setRecordError(approvalError(cause));
    } finally {
      store?.close();
      setBusy(false);
    }
  }

  async function revoke() {
    if (
      busy ||
      !candidate ||
      !record ||
      record.status !== 'approved' ||
      record.trust.enrollmentId !== candidate.trust.enrollmentId
    )
      return;
    setBusy(true);
    setRecordError(null);
    setResult(null);
    let store: Awaited<
      ReturnType<typeof openDeviceConnectionTrustStore>
    > | null = null;
    try {
      store = await openDeviceConnectionTrustStore();
      const latest = await store.read(record.trust.stationId);
      if (
        latest?.status !== 'approved' ||
        latest.revision !== record.revision ||
        latest.trust.enrollmentId !== record.trust.enrollmentId
      )
        throw new Error('device_trust_conflict');
      const revoked = await store.revoke(
        latest.trust.stationId,
        latest.revision,
      );
      setRecord(revoked);
      setConfirmedKeyId(null);
      setResult('Station trust revoked on this browser.');
    } catch (cause) {
      setRecordError(approvalError(cause));
    } finally {
      store?.close();
      setBusy(false);
    }
  }

  const decision =
    candidate && record !== undefined
      ? decideTrust(record, candidate.trust)
      : null;
  const canRevoke = Boolean(
    candidate &&
      record?.status === 'approved' &&
      record.trust.enrollmentId === candidate.trust.enrollmentId,
  );

  return (
    <section
      className="relay-route-trust-approval"
      aria-label="Station signing key approval"
    >
      <h3>Station signing key</h3>
      <p className="connections-computers__note">
        Get the public report from the Station operator through a separate
        trusted channel. A broker invitation does not prove which Station
        supplied a key. If the key is not initialized, the operator can run
        <code>
          npm run --silent connection:key -- initialize --home=&lt;path&gt;
        </code>{' '}
        and then inspect it. For a shorter voice or chat comparison, ask the
        operator to run{' '}
        <code>
          npm run --silent connection:key -- fingerprint --home=&lt;path&gt;
        </code>
        . Paste the public report from{' '}
        <code>
          npm run --silent connection:key -- inspect --home=&lt;path&gt;
        </code>
        .
      </p>
      <label className="editor-field">
        <span className="editor-label">Operator key report (JSON)</span>
        <textarea
          className="editor-textarea editor-textarea--mono"
          aria-label="Operator Station key report"
          rows={4}
          maxLength={MAX_REPORT_BYTES}
          value={reportText}
          disabled={busy}
          onChange={(event) => {
            setCandidate(null);
            setRecord(undefined);
            setRecordError(null);
            setParseError(null);
            setConfirmedKeyId(null);
            setResult(null);
            setReportText(event.target.value);
          }}
        />
      </label>
      {parseError && (
        <p className="connections-computers__alert" role="alert">
          {parseError}
        </p>
      )}
      {candidate && (
        <div
          className={`relay-route-trust relay-route-trust--${decision?.status ?? 'checking'}`}
          role="status"
          aria-label={`Station trust: ${decision?.status ?? 'checking'}`}
        >
          <strong>{decision?.label ?? 'Checking Station trust'}</strong>
          <span>{decision?.detail}</span>
          <span>Station ID: {candidate.trust.stationId}</span>
          <span>Enrollment ID: {candidate.trust.enrollmentId}</span>
          <span>Key generation: {candidate.trust.generation}</span>
          <span>Confirmation code (compare through a separate channel):</span>
          <code className="relay-route-trust-approval__key-id">
            {formatStationConnectionKeyConfirmationCode(candidate.confirmationCode)}
          </code>
          <span>Full Station key ID (SHA-256 JWK thumbprint):</span>
          <code className="relay-route-trust-approval__key-id">
            {candidate.keyId}
          </code>
        </div>
      )}
      {candidate && record === undefined && !recordError && (
        <SkeletonBlock count={1} label="Checking saved Station trust" />
      )}
      {candidate && decision?.canApprove && (
        <label className="relay-route-trust-approval__confirm">
          <input
            type="checkbox"
            checked={confirmedKeyId === candidate.keyId}
            disabled={busy || record === undefined}
            onChange={(event) =>
              setConfirmedKeyId(event.target.checked ? candidate.keyId : null)
            }
          />
          <span>
            I compared the confirmation code and full key ID with the Station
            operator through a separate trusted channel. I did not take either
            value from the broker invitation.
          </span>
        </label>
      )}
      {candidate && decision?.canApprove && (
        <Button
          size="sm"
          disabled={
            busy || record === undefined || confirmedKeyId !== candidate.keyId
          }
          onClick={() => void approve()}
        >
          {busy ? 'Updating Station trust…' : 'Approve Station key'}
        </Button>
      )}
      {canRevoke && (
        <Button size="sm" disabled={busy} onClick={() => void revoke()}>
          Revoke stored Station trust
        </Button>
      )}
      {result && <p role="status">{result}</p>}
      {recordError && (
        <p className="connections-computers__alert" role="alert">
          {recordError}
        </p>
      )}
      <p className="connections-computers__note">
        Rotation requires a higher key generation for the same enrollment.
        Revoked trust stays revoked until a higher-generation key is approved.
        This approval only pins the Station transport key on this browser; it
        does not sign in, approve a Device or grant Project access.
      </p>
    </section>
  );
}
