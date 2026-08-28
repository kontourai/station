import type {
  FleetRoutingCandidate,
  FleetRoutingExclusion,
  FleetRoutingReceiptEnvelope,
} from '@kontourai/station-contracts/fleet-routing-receipt';
import { describeConsumerProbe } from '@kontourai/station-contracts/fleet-routing-receipt';
import { isTerminalConnectionStatus } from '@kontourai/station-contracts/http';
import {
  StationHttpError,
  useFleetRoutingReceiptsQuery,
  useFleetServeReceiptsQuery,
} from '@kontourai/station-sdk';
import { isStationTransportFailure } from '../../utils/stationTransportFailure';

/**
 * archive#3444 fix-round : three arms, one per FACT about what
 * happened — not one per retry-state, which is what the first pass of this
 * fix got wrong.
 *
 * 1. **Terminal rejection** (401/403) — the poll has genuinely stopped
*    (`resolveFleetReceiptsRefetchInterval`, `@kontourai/station-sdk`), so
*    the copy must not claim an automatic retry that will not happen.
 * 2. **Transport failure** — no `Response` ever arrived at all
*    (`isStationTransportFailure`, its actual intended meaning: a
*    network-shaped failure, not any HTTP status). The poll keeps its
*    unconditional 30s cadence here, so "retrying automatically" is honest.
 * 3. **A `Response` arrived carrying an error** — any other non-2xx, or a 2xx
*    body reporting `success: false`. The host DID respond, so "Station
*    isn't responding" would be false; this is the neutral original copy,
*    restored after the fix-round found it had been deleted along with the
*    only honest string for this case. The server's own authored message
*    (preserved verbatim by the fetcher for a rejected response — see
*    `systemRuntimeRequests.ts`) renders separately in the `<details>` block
*    at each call site, so this headline never needs to repeat it.
 */
function describeFleetReceiptsFailure(error: unknown, subject: string): string {
  if (
    error instanceof StationHttpError &&
    isTerminalConnectionStatus(error.status)
  ) {
    return 'Station rejected this request and will not retry automatically — check the connection.';
  }
  if (isStationTransportFailure(error)) {
    return "Station isn't responding right now — retrying automatically.";
  }
  return `Couldn't load ${subject}.`;
}

/**
 * archive#1398 — the web half of the routing-receipt surface
 * (`docs/design/inference-fleet.md` §3.4, §4.5, §11).
 *
 * The design's whole differentiator is the receipt, so this panel exists to
 * make four things impossible to miss, each of which is a way this feature
 * could otherwise lie:
 *
 * 1. **Peer-attested is never rendered as verified.** The honesty label
*    comes from the stored receipt (`evidence.label`), not from a string in
*    this file — so the web surface cannot drift from the CLI's, and a
*    receipt written months ago still renders the claim that was actually
*    made about it.
 * 2. **Exclusions are shown, always.** §4.5's first banned behavior is
*    dropping an unverified capability with no diagnostic (the reference
*    mesh's stale-status filter does exactly this — a node just stops
*    appearing). Every exclusion in the receipt is rendered.
 * 3. **A fallback is a named state.** A turn that succeeded locally after a
*    fleet candidate failed renders its `fell-back-to-local` failure, not a
 * plain success. §4.5's second banned behavior is falling back silently.
 * 4. **A failed read is not an empty list.** The query throws on failure and
*    this renders the error; "nothing has been fleet-routed" is only said
*    when the Station actually said it.
 *
 * Wording is "receipted", never "signed" (§10 OQ-3) — nothing in the
 * building-block layer signs anything, and the chain verdict says exactly
 * what the digests do and do not prove.
 */
/**
* Both halves, rendered together. The serving side's
 * own record is not a footnote to the consuming side's: §3.4's "both sides
 * record" exists because a consumer-authored account of a producer's
 * behaviour is a claim, and the point of the second log is that the two can
 * be compared. A surface that showed only one would quietly re-establish the
 * single-sided provenance the design rejected.
 */
export function FleetReceipts() {
  return (
    <>
      <FleetRoutingReceipts />
      <FleetServeReceipts />
    </>
  );
}

/**
 * What this Station SERVED to its peers. Digest-and-fingerprint only: there
 * is deliberately no prompt, no completion, and no peer identity beyond a
 * credential fingerprint to render, because none of that is recorded.
 */
export function FleetServeReceipts() {
  const { data, isLoading, error } = useFleetServeReceiptsQuery();

 // archive#3444 fix-round : `!error && !data` is also true before
// the query has even started — e.g. while `PersistQueryClientProvider` is
// still restoring from IndexedDB, `isLoading` (`isPending && isFetching`)
// reads `false` because nothing has begun fetching yet. That is not an
// error state; a request has not even been made, so nothing has failed.
  if (isLoading || (!error && !data)) {
    return (
      <section className="fleet-routing" data-testid="fleet-serve-receipts">
        <h3>Fleet inference served</h3>
        <p>Reading what this Station has served…</p>
      </section>
    );
  }

  if (error || !data) {
    const detail = error instanceof Error ? error.message : undefined;
    const message = describeFleetReceiptsFailure(
      error,
      'fleet inference served receipts',
    );
    return (
      <section className="fleet-routing" data-testid="fleet-serve-receipts">
        <h3>Fleet inference served</h3>
        <p role="alert">
          {message} That is unknown, not empty — it does not mean nothing has
          been served.
        </p>
        {detail ? (
          <details>
            <summary>Details</summary>
            <code>{detail}</code>
          </details>
        ) : null}
      </section>
    );
  }

  return (
    <section className="fleet-routing" data-testid="fleet-serve-receipts">
      <h3>Fleet inference served</h3>
      <p className="fleet-routing__chain" data-testid="fleet-serve-chain">
        Chain {data.chain.status}: {data.chain.message}
      </p>
      {data.receipts.length === 0 ? (
        <p>This Station has not served any fleet inference yet.</p>
      ) : (
        <ol className="fleet-routing__list">
          {data.receipts.map((receipt) => (
            <li key={receipt.receiptId}>
              <article className="fleet-routing__receipt">
                <header>
                  <strong>{receipt.requestedModelId ?? 'unknown model'}</strong>{' '}
                  · {receipt.recordedAt} · {receipt.outcome}
                  {receipt.refusalCode ? ` (${receipt.refusalCode})` : ''}
                </header>
                <p className="fleet-routing__served">
                  Peer{' '}
                  {receipt.peerFingerprint
                    ? `${receipt.peerFingerprint.slice(0, 12)}… (credential fingerprint, not an identity this Station verified)`
                    : 'unidentified — no credential was presented'}
                </p>
                <p className="fleet-routing__digest">
                  Request digest {receipt.promptDigest.slice(0, 12)}… — the
                  request content is never recorded. Receipted by content digest{' '}
                  {receipt.receiptId.slice(0, 12)}… — not signed.
                </p>
              </article>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function FleetRoutingReceipts() {
  const { data, isLoading, error } = useFleetRoutingReceiptsQuery();

 // archive#3444 fix-round : see the serving-side sibling above —
// `!error && !data` before the query has even started (e.g. mid
// `PersistQueryClientProvider` IndexedDB restore) is not an error state.
  if (isLoading || (!error && !data)) {
    return (
      <section className="fleet-routing" data-testid="fleet-routing-receipts">
        <h3>Fleet routing</h3>
        <p>Reading this Station's routing receipts…</p>
      </section>
    );
  }

  if (error || !data) {
    const detail = error instanceof Error ? error.message : undefined;
    const message = describeFleetReceiptsFailure(
      error,
      'fleet routing receipts',
    );
    return (
      <section className="fleet-routing" data-testid="fleet-routing-receipts">
        <h3>Fleet routing</h3>
        <p role="alert">
          {message} That is unknown, not empty — it does not mean nothing has
          been routed.
        </p>
        {detail ? (
          <details>
            <summary>Details</summary>
            <code>{detail}</code>
          </details>
        ) : null}
      </section>
    );
  }

  return (
    <section className="fleet-routing" data-testid="fleet-routing-receipts">
      <h3>Fleet routing</h3>
      <p className="fleet-routing__chain" data-testid="fleet-routing-chain">
        Chain {data.chain.status}: {data.chain.message}
      </p>
      {data.receipts.length === 0 ? (
        <p>No turn has been fleet-routed on this Station yet.</p>
      ) : (
        <ol className="fleet-routing__list">
          {data.receipts.map((receipt) => (
            <li key={receipt.receiptId}>
              <FleetRoutingReceiptRow receipt={receipt} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** The evidence sentence. `label` is read from the receipt, never invented here. */
function EvidenceLine({
  evidence,
}: {
  evidence: FleetRoutingCandidate['evidence'];
}) {
  const probe = describeConsumerProbe(evidence.probe);
  return (
    <span className="fleet-routing__evidence">
      Evidence {evidence.level} — {evidence.label}
      {evidence.peerAttested?.observedAt
        ? ` (peer observed ${evidence.peerAttested.observedAt})`
        : ''}
{/* archive#1398. Rendered from the contract's own wording, and
          rendered for a STALE observation too: dropping it would make an
          expired verification indistinguishable from a never-probed
          candidate. */}
      {probe ? ` · ${probe}` : ''}
    </span>
  );
}

function FleetRoutingReceiptRow({
  receipt,
}: {
  receipt: FleetRoutingReceiptEnvelope;
}) {
  return (
    <article className="fleet-routing__receipt">
      <header>
        <strong>{receipt.agentName}</strong> · {receipt.recordedAt} ·{' '}
        {receipt.dispatch.outcome}
      </header>

      {receipt.selection ? (
        <p className="fleet-routing__served">
          Served by{' '}
          {receipt.selection.origin === 'fleet'
            ? (receipt.selection.environmentLabel ??
              receipt.selection.environmentId ??
              'an unnamed peer')
            : 'this Station'}
          {receipt.selection.modelId ? ` · ${receipt.selection.modelId}` : ''} ·{' '}
          <EvidenceLine evidence={receipt.selection.evidence} />
        </p>
      ) : (
        <p className="fleet-routing__served">
          Served by nothing — no candidate produced a completion.
        </p>
      )}

      {receipt.failure && (
        <p className="fleet-routing__failure" role="status">
          {receipt.failure.code}: {receipt.failure.message}
        </p>
      )}

      <p className="fleet-routing__stream">
        Streaming: {receipt.stream.capable ? 'yes' : 'no'} —{' '}
        {receipt.stream.reason}
      </p>

      {receipt.exclusions.length > 0 && (
        <ul className="fleet-routing__exclusions">
          {receipt.exclusions.map((exclusion, index) => (
            <li
// Exclusions carry no id of their own and the same code can
// legitimately appear twice for different models on one peer,
// so the index participates in the key.
              key={`${exclusion.code}-${exclusion.environmentId ?? 'local'}-${exclusion.modelId ?? index}`}
            >
              <ExclusionRow exclusion={exclusion} />
            </li>
          ))}
        </ul>
      )}

      <p className="fleet-routing__digest">
        Receipted by content digest {receipt.receiptId.slice(0, 12)}… — not
        signed.
      </p>
    </article>
  );
}

function ExclusionRow({ exclusion }: { exclusion: FleetRoutingExclusion }) {
  const where =
    exclusion.environmentLabel ?? exclusion.environmentId ?? 'this Station';
  return (
    <>
      <span className="fleet-routing__exclusion-code">{exclusion.code}</span>{' '}
      <span className="fleet-routing__exclusion-target">
        {exclusion.modelId ? `${where} / ${exclusion.modelId}` : where}
      </span>{' '}
      — {exclusion.message}
    </>
  );
}
