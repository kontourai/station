import type { PullRequestReviewGuideResult } from '@kontourai/station-contracts/pull-request-review-guide';
import {
  getPullRequestGuide,
  getPullRequestGuideStatus,
  type PullRequestReviewTarget,
  writePullRequestGuide,
} from '@kontourai/station-sdk/pull-request-review';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { Button } from '../Button';
import { Empty } from '../state';
import './PullRequestGuide.css';

/** Read-only first slice; review actions remain in the Review tab. */
export function PullRequestGuide({
  target,
  headSha,
}: {
  target: PullRequestReviewTarget;
  headSha: string;
}) {
  const scope = useHostRequestAuthorityScope();
  const query = useQuery({
    queryKey: ['pull-request-guide', scope?.authorityKey, target, headSha],
    queryFn: ({ signal }) =>
      getPullRequestGuide(scope!.apiBase, target, {
        signal,
        requestScope: scope!,
      }),
    enabled: !!scope?.isCurrent(),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const running = query.data?.enabled && query.data.run?.state === 'Running';
  const status = useQuery({
    queryKey: [
      'pull-request-guide-status',
      scope?.authorityKey,
      target,
      query.data?.enabled && query.data.run?.state === 'Running'
        ? query.data.run.startedAt
        : undefined,
    ],
    queryFn: ({ signal }) =>
      getPullRequestGuideStatus(scope!.apiBase, target, {
        signal,
        requestScope: scope!,
      }),
    enabled: !!scope?.isCurrent() && !!running,
    retry: false,
    gcTime: 0,
    refetchInterval: 15_000,
  });
  const statusUpdatedAt = status.dataUpdatedAt;
  const statusRunning =
    status.data?.enabled && status.data.run?.state === 'Running';
  useEffect(() => {
    if (running && statusUpdatedAt && !statusRunning) void query.refetch();
  }, [running, statusUpdatedAt, statusRunning, query.refetch]);
  const write = useMutation({
    mutationFn: () =>
      writePullRequestGuide(
        scope!.apiBase,
        target,
        { requestScope: scope! },
        { force: !!(query.data?.enabled && query.data.guide) },
      ),
    onSuccess: () => query.refetch(),
  });
  const result = query.data;
  if (!scope?.isCurrent()) return <p>Reconnect to read this guide.</p>;
  if (query.isPending) return <p role="status">Reading guide…</p>;
  if (query.error) return <p role="alert">{query.error.message}</p>;
  if (!result?.enabled)
    return (
      <p>Enable Review guides in Station settings to read AI-written tours.</p>
    );
  return (
    <div className="pull-request-guide">
      <div className="pull-request-guide__actions">
        <p>AI-written tour · shared on this server</p>
        <Button
          disabled={running || write.isPending}
          onClick={() => write.mutate()}
        >
          {running
            ? 'Writing guide…'
            : result.guide
              ? 'Rewrite guide'
              : 'Write guide'}
        </Button>
      </div>
      {write.error && <p role="alert">{write.error.message}</p>}
      {result.run?.state === 'Failed' && (
        <p role="alert">{result.run.detail}</p>
      )}
      {running && (
        <p role="status">
          The guide is being written. You can leave this tab and return later.
        </p>
      )}
      {result.guide ? (
        <GuideStops key={result.guide.generatedAt} result={result} />
      ) : (
        !running && (
          <Empty
            variant="compact"
            label="Nothing here yet"
            description="Write a tour of the changed files to start reading."
          />
        )
      )}
    </div>
  );
}

function GuideStops({ result }: { result: PullRequestReviewGuideResult }) {
  const [index, setIndex] = useState(0);
  const title = useRef<HTMLHeadingElement>(null);
  const stopId = useId();
  const priorIndex = useRef(index);
  useEffect(() => {
    if (priorIndex.current !== index) title.current?.focus();
    priorIndex.current = index;
  }, [index]);
  const guide = result.guide!;
  const stop = guide.stops[index];
  const stale =
    !result.currentHeadSha || guide.headSha !== result.currentHeadSha;
  if (!stop) return <p>This guide contains no stops.</p>;
  return (
    <>
      {stale && (
        <p role="status">
          This guide describes an earlier revision. Excerpts and line notes are
          hidden. Rewrite the guide to review the current change.
        </p>
      )}
      <p className="pull-request-guide__meta">
        {guide.modelSelection} · {new Date(guide.generatedAt).toLocaleString()}{' '}
        · {guide.headSha.slice(0, 12)}
      </p>
      <nav className="pull-request-guide__actions" aria-label="Guide stops">
        <Button disabled={index === 0} onClick={() => setIndex(index - 1)}>
          Previous
        </Button>
        <span>
          Stop {index + 1} of {guide.stops.length}
        </span>
        <Button
          disabled={index === guide.stops.length - 1}
          onClick={() => setIndex(index + 1)}
        >
          Next
        </Button>
      </nav>
      <article aria-labelledby={stopId}>
        <h3 id={stopId} ref={title} tabIndex={-1}>
          {stop.title}
        </h3>
        <p className="pull-request-guide__summary">{stop.summary}</p>
        {stop.attention && (
          <aside className="pull-request-guide__attention">
            <strong>Look closely · {stop.attention.kind}</strong>
            <p>{stop.attention.note}</p>
          </aside>
        )}
        {!stale &&
          stop.excerpts.map((excerpt, n) => (
            <div
              key={`${excerpt.path}:${excerpt.side}:${excerpt.start}:${n}`}
              className="pull-request-guide__excerpt"
            >
              <strong>{excerpt.path}</strong>
              <p>
                {excerpt.side === 'new' ? 'New' : 'Old'} lines {excerpt.start}–
                {excerpt.end} · {excerpt.caption}
              </p>
              {/* biome-ignore lint/a11y/useSemanticElements: preserve preformatted code while naming its scrollable region. */}
              <pre
                // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must focus this region to scroll long code lines in WebKit.
                tabIndex={0}
                role="region"
                aria-label={`Code excerpt from ${excerpt.path}`}
              >
                <code>
                  {result.excerptContents
                    .find(
                      (content) =>
                        content.path === excerpt.path &&
                        content.side === excerpt.side &&
                        content.start === excerpt.start,
                    )
                    ?.lines.map(
                      (line, index) => `${excerpt.start + index}  ${line}`,
                    )
                    .join('\n') ?? 'Excerpt unavailable in the current diff.'}
                </code>
              </pre>
              <p className="pull-request-guide__scroll-hint">
                Scroll horizontally to read longer lines.
              </p>
            </div>
          ))}
        {stop.files.length > 0 && (
          <ul>
            {stop.files.map((file, index) => (
              <li key={`${file.path}:${index}`}>
                <code>{file.path}</code>
                {file.note ? ` — ${file.note}` : ''}
              </li>
            ))}
          </ul>
        )}
        {!stale &&
          stop.notes.map((note, n) => (
            <aside key={n}>
              <strong>{note.title}</strong>
              <p>
                {note.path}:{note.line} · {note.body}
              </p>
            </aside>
          ))}
        {stop.questions.length > 0 && (
          <>
            <h4>Questions to consider</h4>
            <ul>
              {stop.questions.map((question, index) => (
                <li key={`${question}:${index}`}>{question}</li>
              ))}
            </ul>
          </>
        )}
        {index === guide.stops.length - 1 && (
          <p>Continue in the Review tab to comment or approve this revision.</p>
        )}
      </article>
    </>
  );
}
