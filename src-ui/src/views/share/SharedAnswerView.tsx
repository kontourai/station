import {
  type AnswerShareChannelStatus,
  type AnswerShareChannelUnavailableReason,
  type AnswerShareRefusalReason,
  type AnswerShareViewResult,
  isReadableAnswerShareSchemaVersion,
  PUBLIC_ANSWER_SHARE_VIEW_PATH,
} from '@kontourai/station-contracts/answer-share';
import { useEffect, useState } from 'react';
import { TurnProvenanceCard } from '../../components/chat/TurnProvenanceCard';
import { SkeletonBlock } from '../../components/state';
import { captureShareToken } from './share-token';
import './SharedAnswerView.css';

/**
 * The shared-answer permalink page (archive#1423).
 *
 * A standalone surface, mounted above the app shell in `main.tsx`, and that
 * is a decision rather than a shortcut:
 *
 *  - **No app shell.** The viewer is not this Station's operator. A sidebar
 *    of the operator's projects, a header with their agents, and connection
 *    recovery chrome are all things a share holder has no business seeing.
 *  - **No react-query, no persisted cache.** The repo's data-fetching rule
 *    exists for the operator's app; this page deliberately sits outside
 *    `PersistQueryClientProvider`, because that provider writes fetched data
 *    to the browser's IndexedDB. A share viewer's browser must not end up
 *    holding a persisted slice of someone else's Station. One `fetch`, no
 *    cache, no storage — the same posture `packages/connect` takes for its
 *    own pre-credential surfaces.
 *
 * The token is read from the URL FRAGMENT and sent in a POST body, so it
 * never reaches the server's access log, a proxy log, or a `Referer` header.
 */

type ViewState =
  | { phase: 'loading' }
  | { phase: 'no-token' }
  | { phase: 'unreachable' }
  | { phase: 'unsupported'; schemaVersion: number }
  | { phase: 'refused'; reason: AnswerShareRefusalReason; when?: string }
  | { phase: 'ok'; result: Extract<AnswerShareViewResult, { state: 'ok' }> };

/**
 * One sentence per refusal, each naming the actual state. Nothing here says
 * "not found" for a share that was revoked or has expired: a holder who has
 * proven possession of the token is told what happened to their link, which
 * is the whole point of archive#1423's honest-state requirement. Only
 * `share-not-found` is reachable without the token, and it stays deliberately
 * uninformative.
 */
const REFUSAL_TITLE: Record<AnswerShareRefusalReason, string> = {
  'share-not-found': 'This share link is not valid',
  'share-revoked': 'This share was revoked',
  'share-expired': 'This share has expired',
  'answer-no-longer-available': 'The shared answer is no longer available',
};

const REFUSAL_DETAIL: Record<AnswerShareRefusalReason, string> = {
  'share-not-found':
    'Station has no share matching this link. Ask whoever sent it for a new one.',
  'share-revoked':
    'The person who created this link turned it off. Nothing about the answer is being shown.',
  'share-expired':
    'Share links stop working after their expiry. Ask for a fresh link.',
  'answer-no-longer-available':
    'The share is still live, but the answer it points at can no longer be read on this Station.',
};

/**
 *`reason` arrives off the wire, so it is NOT necessarily a member of
 * the union its type claims — a newer Station sends a reason this build has
 * never heard of, and a hostile or corrupt response can send `constructor`.
 * Indexing a closed `Record` with either is the defect: the first renders an
 * empty heading and a literal "undefined", the second finds a truthy FUNCTION
 * on the prototype chain and returns it as a React child, which throws on a
 * page that has no error boundary above it.
 *
 * Same `Object.hasOwn` guard the sibling card uses for exactly this reason
 * (`TurnProvenanceCard.tsx`) — a reason this build cannot read still has to
 * say something, and what it says must not pretend to be specific.
 */
const UNRECOGNIZED_REFUSAL = {
  title: 'This share cannot be opened',
  detail:
    "Station refused it for a reason this version of the page doesn't recognize. Nothing about the answer is being shown, and nothing about it is being claimed.",
} as const;

function describeRefusal(reason: AnswerShareRefusalReason): {
  title: string;
  detail: string;
} {
  if (
    !Object.hasOwn(REFUSAL_TITLE, reason) ||
    !Object.hasOwn(REFUSAL_DETAIL, reason)
  ) {
    return UNRECOGNIZED_REFUSAL;
  }
  return { title: REFUSAL_TITLE[reason], detail: REFUSAL_DETAIL[reason] };
}

function describeWhen(reason: AnswerShareRefusalReason, when?: string): string {
  if (!when) return '';
  const parsed = Date.parse(when);
  // An unparseable timestamp is dropped rather than printed raw or coerced to
  // an epoch date — a wrong date is a claim, and a missing one is not.
  if (!Number.isFinite(parsed)) return '';
  const verb = reason === 'share-expired' ? 'Expired' : 'Revoked';
  return `${verb} ${new Date(parsed).toLocaleString()}.`;
}

/**
 * Channel-panel copy (archive#1598), and every word of it is L0 in
 * `assurance.md`'s vocabulary: this Station attesting its own log, checkable
 * only from inside it. Nothing here is signed and nothing here has been
 * checked by anyone else.
 *
 * **"verified" and "proven" are banned from this table** until the signing
 * slice lands, and the ban is the same rule
 * `src-server/runtime/conversation/receipt-chain.ts` states for itself:
 * *"because 'we did not check' must never render as 'it verified'."* The
 * design's own word for the good state is `reported`, and the copy says
 * `reports` for the same reason the type does.
 *
 * The two "nothing to report" reasons are worded so they cannot be read as
 * each other. `not-in-channel` is a fact with no remedy — nothing is missing.
 * `predates-channel-addressing` is an admitted unknown — nobody looked.
 */
const CHANNEL_UNAVAILABLE_DETAIL: Record<
  AnswerShareChannelUnavailableReason,
  string
> = {
  'not-in-channel':
    'This Station reports that this answer was not committed to a channel log, so there is no channel position for it. Nothing is missing from what you can see here.',
  'predates-channel-addressing':
    'This share was created before this Station recorded channel positions, so none was observed when it was made. That is not a statement that the answer sits outside a channel — it is that nobody looked.',
  'history-not-served':
    'This share records a channel position, but this Station does not serve channel history to this page, so that position is not being reported here.',
  'coordinate-mismatch':
    'This share records a channel position that disagrees with what this Station reports for that record now. Nothing about its place in the log is being claimed, and nothing else has been put in its place.',
};

/**
 * Same `Object.hasOwn` guard as {@link describeRefusal}, and for the same
 * reason: `reason` arrives off the wire, so a newer Station's reason or a
 * hostile `constructor` must not index a closed `Record` and return a
 * prototype member as a React child.
 */
const UNRECOGNIZED_CHANNEL_DETAIL =
  "This Station said something about this answer's place in a channel log that this version of the page doesn't recognize. Nothing about it is being claimed.";

function describeChannelUnavailable(
  reason: AnswerShareChannelUnavailableReason,
): string {
  if (!Object.hasOwn(CHANNEL_UNAVAILABLE_DETAIL, reason)) {
    return UNRECOGNIZED_CHANNEL_DETAIL;
  }
  return CHANNEL_UNAVAILABLE_DETAIL[reason];
}

/**
 * The channel panel.
 *
 * It renders the status the SERVER computed. It never renders a stored
 * binding, because it never receives one — the payload carries a checked
 * result and nothing else, which is what stops this surface from repeating
 * 's `authorized`-from-an-id-alone defect in channel vocabulary.
 */
function SharedAnswerChannelPanel({
  channel,
}: {
  channel: AnswerShareChannelStatus;
}) {
  if (channel.status === 'reported') {
    return (
      <section className="shared-answer__channel" aria-label="Channel log">
        <h2 className="shared-answer__channel-title">Channel log</h2>
        <p className="shared-answer__channel-detail">
          This Station reports this answer in its channel log at epoch{' '}
          {channel.coordinate.epoch}, entry {channel.coordinate.seq}, in channel{' '}
          <code>{channel.coordinate.channelId}</code>.
          {channel.supersession === 'superseded'
            ? ' It also reports a later entry superseding that one. The words above are the ones that were shared; the later version is not being shown.'
            : ''}
        </p>
      </section>
    );
  }
  return (
    <section className="shared-answer__channel" aria-label="Channel log">
      <h2 className="shared-answer__channel-title">Channel log</h2>
      <p className="shared-answer__channel-detail">
        {describeChannelUnavailable(channel.reason)}
      </p>
    </section>
  );
}

async function loadShare(token: string): Promise<ViewState> {
  let response: Response;
  try {
    response = await fetch(
      `${window.location.origin}${PUBLIC_ANSWER_SHARE_VIEW_PATH}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      },
    );
  } catch {
    return { phase: 'unreachable' };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { phase: 'unreachable' };
  }
  const result = body as Partial<AnswerShareViewResult> & {
    error?: string;
  };
  if (result.state === 'refused' && typeof result.reason === 'string') {
    return {
      phase: 'refused',
      reason: result.reason,
      when: result.revokedAt ?? result.expiresAt,
    };
  }
  if (result.state === 'ok') {
    // A payload from a newer Station is reported as unreadable rather than
    // partially rendered — the same rule the provenance envelope holds, and
    // for the same reason: a half-understood claim is worse than an admitted
    // gap.
    //
    // MEMBERSHIP, not equality (archive#1598). This was
    // `=== ANSWER_SHARE_SCHEMA_VERSION`, which is correct exactly while one
    // version exists: the moment a payload carrying a channel status declares
    // v2, an equality check against either constant refuses half of what this
    // build reads perfectly well — every legacy v1 share would have rendered
    // the "cannot read this format" notice.
    return isReadableAnswerShareSchemaVersion(result.schemaVersion)
      ? {
          phase: 'ok',
          result: result as Extract<AnswerShareViewResult, { state: 'ok' }>,
        }
      : { phase: 'unsupported', schemaVersion: Number(result.schemaVersion) };
  }
  return { phase: 'unreachable' };
}

export function SharedAnswerView() {
  const [state, setState] = useState<ViewState>({ phase: 'loading' });

  useEffect(() => {
    // Reads the token, remembers it for the page's lifetime, and clears the
    // fragment (off the screen, out of session history and session
    // restore). `reloadSharePage` puts it back before any deliberate reload,
    // so the clearing never costs the recipient their recovery path.
    const token = captureShareToken();
    if (!token) {
      setState({ phase: 'no-token' });
      return;
    }
    let cancelled = false;
    void loadShare(token).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="shared-answer" aria-label="Shared answer">
      <header className="shared-answer__header">
        <h1 className="shared-answer__title">Shared answer</h1>
        <p className="shared-answer__subtitle">
          A read-only view of one answer and what it was based on. Nothing else
          on this Station is reachable from this page.
        </p>
      </header>
      <SharedAnswerBody state={state} />
    </main>
  );
}

function SharedAnswerBody({ state }: { state: ViewState }) {
  switch (state.phase) {
    case 'loading':
      // SHELL-13: one loading vocabulary. The wait names itself in the
      // skeleton's `label` rather than in a sentence that agrees with no
      // other wait in the app on casing, ellipsis or noun.
      return (
        <SkeletonBlock
          count={2}
          className="shared-answer__status"
          label="Opening the shared answer"
        />
      );
    case 'no-token':
      return (
        // this state is reached BOTH by a genuinely truncated link and
        // by a manual refresh after this page deliberately cleared the token
        // from the address bar. Blaming the recipient for "copying only part
        // of the link" is wrong in the second case and unhelpful in the
        // first, so the copy names both and asks for the original link.
        <SharedAnswerNotice
          title="This page no longer has the share token"
          detail="Station clears the token out of the address bar once it has been read, so reopening or refreshing this address on its own cannot find it again. Open the original share link — the part after the # is what carries it."
        />
      );
    case 'unreachable':
      return (
        <SharedAnswerNotice
          title="This Station could not be reached"
          detail="The share may still be valid. Nothing about the answer is being shown, because nothing was read."
        />
      );
    case 'unsupported':
      return (
        <SharedAnswerNotice
          title="This share was written in a format this page cannot read"
          detail={`It reports schema version ${state.schemaVersion}. Nothing about the answer is being claimed from it.`}
        />
      );
    case 'refused': {
      const { title, detail } = describeRefusal(state.reason);
      return (
        <SharedAnswerNotice
          title={title}
          detail={`${detail} ${describeWhen(state.reason, state.when)}`.trim()}
        />
      );
    }
    default:
      return <SharedAnswerContent result={state.result} />;
  }
}

function SharedAnswerNotice({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <section className="shared-answer__notice" role="status">
      <h2 className="shared-answer__notice-title">{title}</h2>
      <p className="shared-answer__notice-detail">{detail}</p>
    </section>
  );
}

function SharedAnswerContent({
  result,
}: {
  result: Extract<AnswerShareViewResult, { state: 'ok' }>;
}) {
  return (
    <>
      <article className="shared-answer__body">
        {result.answer.blocks.length === 0 ? (
          <p className="shared-answer__status">
            This turn recorded provenance but committed nothing readable as
            text.
          </p>
        ) : (
          result.answer.blocks.map((block, index) => (
            <p
              className="shared-answer__block"
              // Blocks have no ids of their own and their order is the
              // answer's order; the list never reorders or mutates.
              key={index}
            >
              {block.text}
            </p>
          ))
        )}
        {result.answer.omittedBlocks > 0 && (
          <p className="shared-answer__omitted">
            {result.answer.omittedBlocks} further block(s) of this answer are
            not shown here.
          </p>
        )}
      </article>

      {result.provenance === undefined ? (
        <p className="shared-answer__status">
          This answer carries no provenance envelope, so nothing is being
          claimed about how it was produced.
        </p>
      ) : (
        <TurnProvenanceCard provenance={result.provenance} />
      )}

      {/* Absent only when the payload came from a Station older than
          station#1598. Rendering a panel then would mean inventing a status
          on the client, which is the read-time derivation this slice
          refuses. */}
      {result.channel !== undefined && (
        <SharedAnswerChannelPanel channel={result.channel} />
      )}

      <footer className="shared-answer__footer">
        Shared {new Date(result.share.createdAt).toLocaleDateString()} · expires{' '}
        {new Date(result.share.expiresAt).toLocaleDateString()}
        {result.share.label ? ` · ${result.share.label}` : ''}
      </footer>
    </>
  );
}
