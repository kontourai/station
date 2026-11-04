import { createProductTelemetryIncidentDraft } from '@kontourai/station-contracts/product-telemetry';
import { workItemRefFromGitHubIssueUrl } from '@kontourai/station-contracts/work-item-provider';
import {
  useTelemetryCompanionIncidentLinkMutation,
  useTelemetryCompanionIncidentLinksQuery,
  useTelemetryCompanionProductIncidentsQuery,
} from '@kontourai/station-sdk';
import { useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Empty, SkeletonBlock } from '../../components/state';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { copyToClipboard } from '../../lib/clipboard';
import { newCompanionOperationId } from './companion-operation-id';

export function CompanionProductIncidents({
  authority,
  window,
}: {
  authority: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
  window: { from: string; to: string };
}) {
  const query = useTelemetryCompanionProductIncidentsQuery(
    authority.apiBase,
    window,
    { requestScope: authority },
  );
  const [selected, setSelected] = useState(''),
    [message, setMessage] = useState(''),
    [page, setPage] = useState(0);
  const data = !query.isError && !query.isFetching ? query.data : undefined;
  const draft = data
    ? createProductTelemetryIncidentDraft(data, selected)
    : null;
  async function review(id: string, copy = false) {
    setMessage('');
    const result = await query.refetch();
    if (result.isError || !result.data || !authority.isCurrent()) {
      setMessage(
        'Incident evidence is unavailable. Refresh operator access before exporting.',
      );
      return;
    }
    const fresh = createProductTelemetryIncidentDraft(result.data, id);
    if (!fresh) {
      setMessage(
        'This incident group is no longer available in the selected window.',
      );
      return;
    }
    setSelected(id);
    if (copy) {
      if (!authority.isCurrent()) return;
      const copied = await copyToClipboard(`${fresh.title}\n\n${fresh.body}`);
      if (authority.isCurrent())
        setMessage(
          copied
            ? 'Draft copied for review.'
            : 'Copy unavailable; select the draft text.',
        );
    }
  }
  return (
    <section
      className="companion-product-incidents companion-managed"
      aria-label="Received product incidents"
    >
      <h3>Received product incidents</h3>
      <p>
        Received observations grouped by component, classified failure and
        process build. Installation counts use reported identifiers; delivery
        coverage is unknown. Storage probes create no product observations.
      </p>
      {message ? <p role="status">{message}</p> : null}
      {query.isError ? (
        <p role="alert">
          Incident evidence is unavailable. Previous groups and drafts are
          hidden.
        </p>
      ) : !data ? (
        <p role="status">Reading incident evidence…</p>
      ) : (
        <>
          <p>
            UTC window {data.window.from} to {data.window.to} (end excluded).
            Retention: {data.retentionDays} days. Failed, aborted, unresolved
            and unknown observations remain separate.
          </p>
          {data.rows.length === 0 ? (
            <p>
              No received problem groups in this window. Missing delivery can
              hide activity.
            </p>
          ) : (
            <>
              <ul>
                {data.rows.slice(page * 25, (page + 1) * 25).map((group) => (
                  <li key={group.id}>
                    <p>
                      {group.event} · {group.engine ?? 'unattributed engine'} ·{' '}
                      {group.failureKind} · {group.build.version}
                    </p>
                    <p>
                      {group.populations.failed} failed;{' '}
                      {group.populations.aborted} aborted;{' '}
                      {group.populations.unresolved} unresolved;{' '}
                      {group.populations.unknown} unknown. Observed denominator:{' '}
                      {group.observed}; {group.populations.succeeded} succeeded.
                      Affected reported installations: {group.affectedInstalls}/
                      {group.observedInstalls}.
                    </p>
                    <Button
                      variant="secondary"
                      onClick={() => void review(group.id)}
                    >
                      Review issue draft
                    </Button>
                  </li>
                ))}
              </ul>
              <div className="companion-product-trends__controls">
                <Button
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous incidents
                </Button>
                <Button
                  disabled={(page + 1) * 25 >= data.rows.length}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next incidents
                </Button>
              </div>
            </>
          )}
          {draft ? (
            <div className="companion-incident-draft">
              <h4>{draft.title}</h4>
              <label>
                Reviewable issue draft
                <textarea readOnly rows={14} value={draft.body} />
              </label>
              <p>
                Review reproduction steps and attachments before publishing
                through your chosen tracker.
              </p>
              <Button onClick={() => void review(selected, true)}>
                Copy reviewed draft
              </Button>
              <IncidentIssueLinks
                key={`${authority.authorityKey}:${selected}:${window.from}:${window.to}`}
                authority={authority}
                window={window}
                groupId={selected}
              />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function IncidentIssueLinks({
  authority,
  window,
  groupId,
}: {
  authority: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
  window: { from: string; to: string };
  groupId: string;
}) {
  const query = useTelemetryCompanionIncidentLinksQuery(
    authority.apiBase,
    groupId,
    window,
    { requestScope: authority },
  );
  const mutation = useTelemetryCompanionIncidentLinkMutation(
    authority.apiBase,
    { requestScope: authority },
  );
  const [issueUrl, setIssueUrl] = useState(''),
    [notice, setNotice] = useState('');
  const attempt = useRef<{ url: string; id: string } | undefined>(undefined);
  const { DiscardModal } = useUnsavedGuard(issueUrl.length > 0);
  const data = !query.isError && !query.isFetching ? query.data : undefined;
  async function link() {
    if (!authority.isCurrent()) return;
    const url = issueUrl.trim();
    if (!workItemRefFromGitHubIssueUrl(url)) {
      setNotice('Use a canonical GitHub issue URL without query parameters.');
      return;
    }
    const current =
      attempt.current?.url === url
        ? attempt.current
        : { url, id: newCompanionOperationId() };
    attempt.current = current;
    setNotice('');
    try {
      const result = await mutation.mutateAsync({
        kind: 'link',
        operationId: current.id,
        groupId,
        window,
        issueUrl: url,
      });
      if (authority.isCurrent()) {
        setIssueUrl('');
        attempt.current = undefined;
        setNotice(
          result.state === 'active'
            ? 'Issue reference linked.'
            : 'This operation was already removed; it was not recreated.',
        );
      }
    } catch {
      if (authority.isCurrent())
        setNotice(
          'The link was not confirmed. Check current links or retry this same reference.',
        );
    }
  }
  async function unlink(linkId: string) {
    setNotice('');
    try {
      await mutation.mutateAsync({ kind: 'unlink', linkId, groupId, window });
      if (authority.isCurrent())
        setNotice(
          'Issue reference removed. The external issue was not changed.',
        );
    } catch {
      if (authority.isCurrent())
        setNotice(
          'Removal was not confirmed. Refresh current links before trying again.',
        );
    }
  }
  return (
    <section aria-label="Linked incident issues">
      <h4>Linked issues</h4>
      <p>
        User-supplied GitHub references. Linking does not verify issue existence
        or publish to the tracker. References expire after 30 days; expired
        bytes are pruned on a later link mutation.
      </p>
      {notice ? <p role="status">{notice}</p> : null}
      {query.isError ? (
        <p role="alert">
          Current issue references are unavailable. Previous references are
          hidden.
        </p>
      ) : !data ? (
        <SkeletonBlock count={1} label="Reading current issue references…" />
      ) : (
        <>
          {data.length === 0 ? (
            <Empty variant="compact" label="Link an issue to this group." />
          ) : (
            <ul>
              {data.map((link) => (
                <li key={link.id}>
                  <a
                    href={link.issue.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {link.issue.workItemRef}
                  </a>{' '}
                  <Button
                    variant="danger-outline"
                    disabled={mutation.isPending}
                    onClick={() => void unlink(link.id)}
                  >
                    Remove issue reference
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <label>
            Existing GitHub issue URL
            <input
              type="url"
              maxLength={2048}
              value={issueUrl}
              onChange={(event) => setIssueUrl(event.target.value)}
            />
          </label>
          <Button
            pending={mutation.isPending}
            disabled={!issueUrl.trim() || data.length >= 8}
            onClick={() => void link()}
          >
            Link existing issue
          </Button>
        </>
      )}
      <DiscardModal />
    </section>
  );
}
