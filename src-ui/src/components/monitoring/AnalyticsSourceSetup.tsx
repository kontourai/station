import {
  type AnalyticsEncryptedDelivery,
  type AnalyticsRecipientSetup,
  type AnalyticsReview,
  type AnalyticsSourceOffer,
  analyticsReviewUrl,
  type PrivateInsightsAuthority,
  type PrivateInsightsSource,
  parseAnalyticsTransfer,
  useAnalyticsReceiverInfo,
  useAnalyticsReceivingProof,
  useAnalyticsSetupMutation,
  useAnalyticsSetupReview,
  useAnalyticsSourceOffers,
} from '@kontourai/station-sdk/private-insights-query';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useState } from 'react';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { copyToClipboard } from '../../lib/clipboard';
import { prepareRequesterConsentReview } from '../../platform/native/requesterConsent';
import { Button } from '../Button';

function Packet({ label, value }: { label: string; value: unknown }) {
  const [notice, setNotice] = useState('');
  const text = JSON.stringify(value, null, 2);
  return (
    <div className="analytics-setup-packet">
      <label>
        {label}
        <textarea readOnly rows={5} value={text} />
      </label>
      <Button
        variant="ghost"
        onClick={async () =>
          setNotice(
            (await copyToClipboard(text))
              ? 'Copied'
              : 'Copy unavailable; select the packet text.',
          )
        }
      >
        Copy {label.toLowerCase()}
      </Button>
      {notice ? <p role="status">{notice}</p> : null}
    </div>
  );
}
/** Coordinates public/encrypted packets; all approvals and private keys stay with their existing owners. */
export function AnalyticsSourceSetup({
  scope,
  sources,
}: {
  scope: PrivateInsightsAuthority;
  sources: readonly PrivateInsightsSource[];
}) {
  const action = useAnalyticsSetupMutation(scope),
    info = useAnalyticsReceiverInfo(scope);
  const [tab, setTab] = useState<'receive' | 'share'>('receive');
  const [destination, setDestination] = useState(''),
    [destinationOrigin, setDestinationOrigin] = useState('');
  const [scopeChoice, setScopeChoice] = useState<
    'individual' | 'personal-account'
  >('individual');
  const [retention, setRetention] = useState('live-mirror');
  const offers = useAnalyticsSourceOffers(tab === 'share' ? scope : undefined);
  const [offer, setOffer] = useState<AnalyticsSourceOffer>(),
    [offerInput, setOfferInput] = useState(''),
    [sourceOrigin, setSourceOrigin] = useState('');
  const [proofInput, setProofInput] = useState(''),
    [deliveryInput, setDeliveryInput] = useState('');
  const [recipient, setRecipient] = useState<AnalyticsRecipientSetup>(),
    [recipientId, setRecipientId] = useState('');
  const [approvalId, setApprovalId] = useState(''),
    [encrypted, setEncrypted] = useState<AnalyticsEncryptedDelivery>();
  const [sourceReview, setSourceReview] = useState<AnalyticsReview>(),
    [addressReview, setAddressReview] = useState<AnalyticsReview>();
  const sourceStatus = useAnalyticsSetupReview(scope, sourceReview),
    addressStatus = useAnalyticsSetupReview(scope, addressReview);
  const recovered = useAnalyticsReceivingProof(scope, recipientId);
  const setup = recovered.data ?? recipient;
  const candidate =
    setup && ['candidate', 'credential-stored'].includes(setup.phase)
      ? setup
      : undefined;
  const [message, setMessage] = useState('');
  const { guard, DiscardModal } = useUnsavedGuard(
    !!(offerInput || proofInput || deliveryInput),
  );
  async function run(input: Parameters<typeof action.mutateAsync>[0]) {
    setMessage('');
    try {
      const result = await action.mutateAsync(input);
      if (result.message) setMessage(result.message);
      return result;
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Source setup failed',
      );
      return undefined;
    }
  }
  async function review(input: Parameters<typeof action.mutateAsync>[0]) {
    const windowRef = prepareRequesterConsentReview();
    if (!windowRef) {
      setMessage(
        'This host could not open the trusted requester review window. Nothing was approved.',
      );
      return;
    }
    const result = await run(input);
    try {
      const value = result?.review;
      if (!value) {
        windowRef.close();
        return;
      }
      if (value.kind === 'source') {
        setSourceReview(value);
        setApprovalId(value.subject);
      } else setAddressReview(value);
      if (value.status === 'approved') {
        windowRef.close();
        return;
      }
      const url = analyticsReviewUrl(scope, value);
      const status = await windowRef.show(value.id, url);
      if (status && scope.isCurrent())
        setMessage(`Requester review: ${status}.`);
    } catch (error) {
      windowRef.close();
      setMessage(
        error instanceof Error ? error.message : 'Requester review unavailable',
      );
    }
  }
  const sourceDecision =
    sourceReview?.subject === approvalId
      ? (sourceStatus.data?.status ?? sourceReview.status)
      : undefined;
  const addressDecision =
    addressReview?.subject === recipientId
      ? (addressStatus.data?.status ?? addressReview.status)
      : undefined;
  return (
    <details className="analytics-source-setup">
      <summary>Connect or manage private sources</summary>
      <p>
        Use these steps on the source and receiving Stations. Transfer only the
        public offer/key proof and encrypted connection packet. Review
        permission on the separate trusted page.
      </p>
      <div className="personal-insights-actions">
        <Button
          active={tab === 'receive'}
          onClick={() => guard(() => setTab('receive'))}
        >
          Receive usage here
        </Button>
        <Button
          active={tab === 'share'}
          onClick={() => guard(() => setTab('share'))}
        >
          Share this Station
        </Button>
      </div>
      {tab === 'share' ? (
        <>
          <h4>1. Create a source offer</h4>
          <label>
            Existing source offer
            <select
              value={offer?.operationId ?? ''}
              onChange={(e) => {
                const selected = offers.data?.find(
                  (v) => v.operationId === e.target.value,
                );
                setOffer(selected);
                setApprovalId(selected?.operationId ?? '');
                setSourceReview(undefined);
                setEncrypted(undefined);
              }}
            >
              <option value="">New offer</option>
              {offers.data?.map((v) => (
                <option key={v.operationId} value={v.operationId}>
                  {v.sourceStationId} · {v.operationId} · {v.phase}
                </option>
              ))}
            </select>
          </label>
          <div className="personal-insights-controls">
            <label>
              Receiving Station ID
              <input
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                maxLength={200}
              />
            </label>
            <label>
              Receiving Station address
              <input
                type="url"
                value={destinationOrigin}
                onChange={(e) => setDestinationOrigin(e.target.value)}
              />
            </label>
            <label>
              Usage scope
              <select
                value={scopeChoice}
                onChange={(e) =>
                  setScopeChoice(
                    e.target.value === 'personal-account'
                      ? 'personal-account'
                      : 'individual',
                  )
                }
              >
                <option value="individual">My individual usage</option>
                <option value="personal-account">
                  My personal-account identities
                </option>
              </select>
            </label>
            <label>
              Copy policy
              <select
                value={retention}
                onChange={(e) => setRetention(e.target.value)}
              >
                <option value="live-mirror">Live mirror</option>
                <option value="7">Retained copy · 7 days</option>
                <option value="30">Retained copy · 30 days</option>
                <option value="90">Retained copy · 90 days</option>
              </select>
            </label>
          </div>
          <p>
            Source access expires after 24 hours. A retained copy can remain for
            its approved copy period; live mirroring needs current access.
          </p>
          <Button
            disabled={!destination || !destinationOrigin}
            pending={action.isPending}
            pendingLabel="Preparing…"
            onClick={async () => {
              const result = await run({
                kind: 'offer',
                operationId: randomCorrelationId(),
                destinationStationId: destination,
                destinationOrigin,
                scope: scopeChoice,
                expiresAt: new Date(Date.now() + 86400000).toISOString(),
                retention:
                  retention === 'live-mirror'
                    ? { mode: 'live-mirror' }
                    : { mode: 'retained-copy', days: Number(retention) },
              });
              if (result?.offer) {
                setOffer(result.offer);
                setApprovalId(result.offer.operationId);
              }
            }}
          >
            Create public offer
          </Button>
          {offer ? <Packet label="Public source offer" value={offer} /> : null}
          <h4>3. Review the receiving key</h4>
          <label>
            Public receiving-key proof
            <textarea
              rows={5}
              value={proofInput}
              maxLength={24576}
              onChange={(e) => setProofInput(e.target.value)}
            />
          </label>
          <p>
            Compare the receiving-key confirmation code with the receiving
            Station before approving. A self-signed person claim is not identity
            authentication.
          </p>
          <Button
            disabled={!proofInput}
            pending={action.isPending}
            onClick={() => {
              try {
                void review({
                  kind: 'source-review',
                  proof: parseAnalyticsTransfer(proofInput),
                });
              } catch (error) {
                setMessage(
                  error instanceof Error
                    ? error.message
                    : 'Invalid receiving proof',
                );
              }
            }}
          >
            Review source permission
          </Button>
          {sourceDecision ? (
            <p role="status">
              Source review: {sourceDecision}. Approval alone has not started
              sync.
            </p>
          ) : null}
          {sourceStatus.error ? (
            <p role="alert">
              Review status could not be checked. No approval is inferred.
            </p>
          ) : null}
          <label>
            Approved source ID
            <input
              value={approvalId}
              onChange={(e) => {
                setApprovalId(e.target.value);
                setEncrypted(undefined);
                setSourceReview(undefined);
              }}
            />
          </label>
          <div className="personal-insights-actions">
            <Button
              disabled={!approvalId}
              pending={action.isPending}
              onClick={async () => {
                const result = await run({ kind: 'delivery', approvalId });
                if (result?.delivery) setEncrypted(result.delivery);
              }}
            >
              Create encrypted connection
            </Button>
            <Button
              variant="danger-outline"
              disabled={!approvalId}
              onClick={() => void run({ kind: 'revoke-source', approvalId })}
            >
              Revoke source access
            </Button>
          </div>
          {encrypted ? (
            <Packet label="Encrypted connection packet" value={encrypted} />
          ) : null}
        </>
      ) : (
        <>
          <h4>This receiving Station</h4>
          {info.data ? (
            <Packet label="Receiver identity" value={info.data} />
          ) : (
            <p role="status">
              Receiving identity is unavailable until its handshake can be read.
            </p>
          )}
          <h4>2. Prepare a receiving key</h4>
          {setup?.phase === 'restore-required' ? (
            <p role="alert">
              This slot cannot be used in this home activation. Prepare a new
              receiving key and obtain fresh source permission.
            </p>
          ) : null}

          <label>
            Public source offer
            <textarea
              rows={5}
              value={offerInput}
              maxLength={24576}
              onChange={(e) => setOfferInput(e.target.value)}
            />
          </label>
          <label>
            HTTPS source address
            <input
              type="url"
              value={sourceOrigin}
              onChange={(e) => setSourceOrigin(e.target.value)}
            />
          </label>
          <Button
            disabled={!offerInput || !sourceOrigin}
            pending={action.isPending}
            onClick={async () => {
              try {
                if (new URL(sourceOrigin).protocol !== 'https:')
                  throw new Error('Use the authenticated HTTPS source address');
                const result = await run({
                  kind: 'receive',
                  operationId: randomCorrelationId(),
                  offer: parseAnalyticsTransfer(offerInput),
                  sourceOrigin,
                });
                if (result?.recipient) {
                  setRecipient(result.recipient);
                  setRecipientId(result.recipient.candidate.claims.recipientId);
                }
              } catch (error) {
                setMessage(
                  error instanceof Error
                    ? error.message
                    : 'Invalid source offer',
                );
              }
            }}
          >
            Prepare receiving key
          </Button>
          <label>
            Owned receiving slot
            <select
              value={recipientId}
              onChange={(e) => {
                setRecipientId(e.target.value);
                setRecipient(undefined);
              }}
            >
              <option value="">Choose a slot</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.stationId} · {s.id}
                </option>
              ))}
            </select>
          </label>
          {candidate ? (
            <>
              <p>
                Receiving-key confirmation code:{' '}
                <strong>{candidate.confirmationCode}</strong>
              </p>
              <Packet
                label="Public receiving-key proof"
                value={candidate.candidate}
              />
            </>
          ) : null}
          {recovered.error ? (
            <p role="alert">
              The receiving proof could not be read for this person.
            </p>
          ) : null}
          <h4>4. Store the encrypted connection</h4>
          <label>
            Encrypted connection packet
            <textarea
              rows={5}
              value={deliveryInput}
              maxLength={24576}
              onChange={(e) => setDeliveryInput(e.target.value)}
            />
          </label>
          <Button
            disabled={!deliveryInput}
            pending={action.isPending}
            onClick={async () => {
              try {
                const result = await run({
                  kind: 'store-delivery',
                  delivery: parseAnalyticsTransfer(deliveryInput),
                });
                if (result?.recipient) {
                  setRecipient(result.recipient);
                  setRecipientId(result.recipient.candidate.claims.recipientId);
                }
              } catch (error) {
                setMessage(
                  error instanceof Error
                    ? error.message
                    : 'Invalid encrypted connection',
                );
              }
            }}
          >
            Store encrypted connection
          </Button>
          <div className="personal-insights-actions">
            <Button
              disabled={!recipientId}
              onClick={() =>
                void review({ kind: 'address-review', recipientId })
              }
            >
              Review source address
            </Button>
            <Button
              disabled={!recipientId}
              variant="danger-outline"
              onClick={() => void run({ kind: 'cancel-receiver', recipientId })}
            >
              Stop receiving source
            </Button>
          </div>
          {addressDecision ? (
            <p role="status">
              Address review: {addressDecision}.{' '}
              {addressDecision === 'approved'
                ? 'Refresh the source list, then select it for sync and Insights.'
                : ''}
            </p>
          ) : null}
          {addressStatus.error ? (
            <p role="alert">
              Address review status could not be checked. Access is not assumed.
            </p>
          ) : null}
        </>
      )}
      {message ? <p role="status">{message}</p> : null}
      <p>
        Stopping a receiving slot stops local writes; it does not claim
        remote-copy erasure. Source access, companion control and telemetry
        sending have separate approvals.
      </p>
      <DiscardModal />
    </details>
  );
}
