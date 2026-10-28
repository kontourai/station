import {
  PROJECT_CHECKOUT_FRESHNESS_PREVIEW_ID,
  type ProjectCheckoutFreshness,
} from '@kontourai/station-contracts/project-checkout-freshness';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { PageCallout } from '../../components/PageCallout';
import { ErrorState } from '../../components/state';
import { useScopedProjectCheckoutFreshnessQuery } from '../../contexts/ProjectsContext';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { copyToClipboard } from '../../lib/clipboard';
import { userFacingErrorMessage } from '../../utils/errorText';
import { relativeTimeAgo } from '../../utils/relativeTime';
import './ProjectCheckoutFreshnessNotice.css';

type Stale = Extract<ProjectCheckoutFreshness, { status: 'stale' }>;

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * The warning itself. Station never runs the command: the person copies it
 * and runs it where the checkout lives.
 */
export function ProjectCheckoutStaleCallout({
  freshness,
  now = Date.now(),
}: {
  freshness: Stale;
  now?: number;
}) {
  const [copied, setCopied] = useState(false);
  const fetchedAt = freshness.upstreamFetchedAt
    ? Date.parse(freshness.upstreamFetchedAt)
    : undefined;
  const fetchedAgo =
    fetchedAt !== undefined && Number.isFinite(fetchedAt)
      ? relativeTimeAgo(fetchedAt, now)
      : undefined;
  // Only an old fetch: the local refs show nothing behind, but cannot be
  // trusted to.
  const title =
    freshness.behind > 0
      ? `Checkout is ${plural(freshness.behind, 'commit')} behind ${freshness.upstream}`
      : `Checkout last fetched ${fetchedAgo ?? 'long ago'}`;
  return (
    <PageCallout
      calloutId="stale-project-checkout"
      tone="warning"
      ariaLabel="Stale checkout"
      data-testid="project-checkout-stale"
      title={title}
      action={
        <Button
          onClick={() => {
            void copyToClipboard(freshness.updateCommand).then(setCopied);
          }}
        >
          {copied ? 'Copied' : 'Copy command'}
        </Button>
      }
    >
      <p>
        {freshness.behind > 0
          ? 'Agents started here follow this checkout’s instructions.'
          : `It may be behind ${freshness.upstream}, and agents here follow its instructions.`}
      </p>
      <pre className="project-checkout-stale__command">
        <code>{freshness.updateCommand}</code>
      </pre>
      {freshness.ahead > 0 && (
        <p>
          {`It also has ${plural(freshness.ahead, 'local commit')}, so this pull will refuse until they are merged.`}
        </p>
      )}
      <p className="project-checkout-stale__meta">
        {fetchedAgo
          ? `Branch ${freshness.branch}, as of a fetch ${fetchedAgo}.`
          : `Branch ${freshness.branch}, as of its last fetch.`}
      </p>
    </PageCallout>
  );
}

/**
 * Shown in a Project's Workspace settings while the Stale checkout warning
 * preview is on and the checkout reads as stale. A checkout Station tried
 * and failed to read says so in one quiet line. Nothing renders while the
 * preview is off, while the read is pending, when the checkout is not stale,
 * or when there is nothing to compare (no git checkout, a detached HEAD, no
 * upstream).
 */
export function ProjectCheckoutFreshnessNotice({ slug }: { slug: string }) {
  const enabled = useSurfaceVisibilityFlags().has(
    PROJECT_CHECKOUT_FRESHNESS_PREVIEW_ID,
  );
  const query = useScopedProjectCheckoutFreshnessQuery(slug, { enabled });
  if (!enabled) return null;
  if (query.error && !query.data) {
    return (
      <ErrorState
        variant="compact"
        title="Could not check whether this checkout is up to date"
        description={userFacingErrorMessage(query.error)}
        action={
          <Button
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        }
      />
    );
  }
  if (
    query.data?.status === 'unknown' &&
    (query.data.reason === 'config-refused' ||
      query.data.reason === 'unreadable')
  ) {
    return (
      <p
        className="project-checkout-stale__unchecked"
        data-testid="project-checkout-unchecked"
      >
        {query.data.reason === 'config-refused'
          ? 'Station did not compare this checkout with its upstream: its git config sets options Station refuses.'
          : 'Station could not compare this checkout with its upstream.'}
      </p>
    );
  }
  if (query.data?.status !== 'stale') return null;
  return <ProjectCheckoutStaleCallout freshness={query.data} />;
}
