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
  return (
    <PageCallout
      calloutId="stale-project-checkout"
      tone="warning"
      ariaLabel="Stale checkout"
      data-testid="project-checkout-stale"
      title={`Checkout is ${plural(freshness.behind, 'commit')} behind ${freshness.upstream}`}
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
      <p>Agents started here follow this checkout’s instructions.</p>
      <pre className="project-checkout-stale__command">
        <code>{freshness.updateCommand}</code>
      </pre>
      {freshness.ahead > 0 && (
        <p>
          {`It also has ${plural(freshness.ahead, 'local commit')}, so this pull will refuse until they are merged.`}
        </p>
      )}
      <p className="project-checkout-stale__meta">
        {fetchedAt !== undefined && Number.isFinite(fetchedAt)
          ? `Branch ${freshness.branch}, as of a fetch ${relativeTimeAgo(fetchedAt, now)}.`
          : `Branch ${freshness.branch}, as of its last fetch.`}
      </p>
    </PageCallout>
  );
}

/**
 * Shown in a Project's Workspace settings while the Stale checkout warning
 * preview is on and the checkout reads as stale. Nothing renders while the
 * preview is off, while the read is pending, or when the checkout is not
 * stale or cannot be judged.
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
  if (query.data?.status !== 'stale') return null;
  return <ProjectCheckoutStaleCallout freshness={query.data} />;
}
