import { useEffect, useReducer } from 'react';
import { relativeTime } from '../../utils/relativeTime';
import {
  formatElapsed,
  type WorkStatus,
  type WorkStatusRung,
} from '../../views/home/work-status';
import {
  CheckGlyph,
  CloseGlyph,
  EditGlyph,
  HandGlyph,
  InfoGlyph,
  LockGlyph,
  MonitorGlyph,
  MoonGlyph,
  OutboxGlyph,
  PeopleGlyph,
  PlayGlyph,
  QuestionGlyph,
  ShieldGlyph,
  TimeGlyph,
  WarningGlyph,
} from '../icons/Glyph';
import type { InboxRowChip, InboxRowChipKind } from './inbox-row-chips';

/**
 * One icon per rung, so a status is never colour-only: the icon and the word
 * both say it. Exhaustive over the ladder's rungs; a new rung fails typecheck
 * here rather than rendering iconless.
 */
const RUNG_GLYPHS: Record<
  WorkStatusRung,
  (props: { className?: string }) => React.ReactElement
> = {
  approval: ShieldGlyph,
  answer: QuestionGlyph,
  waiting: HandGlyph,
  queued: OutboxGlyph,
  blocked: LockGlyph,
  interrupted: WarningGlyph,
  failed: CloseGlyph,
  stopped: CloseGlyph,
  unanswerable: InfoGlyph,
  childWork: PeopleGlyph,
  // A clock, never the play triangle: this run is not visibly progressing.
  quiet: TimeGlyph,
  running: PlayGlyph,
  draft: EditGlyph,
  done: CheckGlyph,
  idle: MoonGlyph,
  external: MonitorGlyph,
};

export function InboxRowStatusGlyph({ rung }: { rung: WorkStatusRung }) {
  const Glyph = RUNG_GLYPHS[rung];
  return <Glyph className="inbox-row__status-glyph" />;
}

/**
 * A duration that ticks once a second, read straight off the wall clock:
 * `Date.now() - since`, on its own interval, depending on `since` alone.
 *
 * It deliberately does NOT use the list's `now`. That clock is coarse (it
 * advances every 30 seconds, for minute-granularity words), so anchoring to
 * it showed "0s" for a turn already 20-30 seconds old and stayed behind for
 * the turn's whole life. Text only: nothing here animates.
 */
function TickingElapsed({ since }: { since: number }) {
  const [, tick] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatElapsed(Date.now() - since)}</>;
}

/** What a screen reader hears instead of a number that changes every
 *  second: a coarse duration that only moves when the host's clock does. */
function coarseDuration(elapsedMs: number): string {
  const minutes = Math.round(elapsedMs / 60_000);
  if (minutes < 1) return 'for under a minute';
  if (minutes < 60)
    return `for about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `for about ${hours} hour${hours === 1 ? '' : 's'}`;
}

/** The detail's test id names what it is the basis for, where one exists. */
const DETAIL_TEST_IDS: Partial<Record<WorkStatusRung, string>> = {
  unanswerable: 'inbox-row-answerability',
  failed: 'inbox-row-failure-reason',
  stopped: 'inbox-row-failure-reason',
};

/**
 * The rungs whose detail is a REASON the user needs in full: why it failed,
 * why nothing here can answer it. For these the fixed one-line budget
 * yields: the line may wrap to two lines rather than cut the reason off
 * (archive#1783 requires the unanswerable basis on the row itself). The
 * whole text is always in the DOM, so the row's `aria-describedby` reads all
 * of it, and the row's details surface shows it unclamped.
 */
const REASON_RUNGS: ReadonlySet<WorkStatusRung> = new Set([
  'failed',
  'stopped',
  'unanswerable',
]);

/**
 * The row's single status line: icon, word, then whatever the ladder says
 * the word is about, then a ticking duration while a turn is open.
 */
export function InboxRowStatusLine({
  status,
  now,
  id,
  lastActivityAt,
  compact = false,
}: {
  lastActivityAt?: number;
  compact?: boolean;
  status: WorkStatus;
  now: number;
  id: string;
}) {
  const wraps = REASON_RUNGS.has(status.rung) && Boolean(status.detail);
  const word =
    compact && status.rung === 'answer'
      ? 'Input'
      : compact && status.rung === 'approval'
        ? 'Approval'
        : status.word;
  return (
    <span
      id={id}
      className={`inbox-row__status${wraps ? ' inbox-row__status--reason' : ''}`}
      data-tone={status.tone}
      data-testid="inbox-row-status"
    >
      <InboxRowStatusGlyph rung={status.rung} />
      <span className="inbox-row__word">{word}</span>
      {status.detail && (
        <>
          <span className="inbox-row__sep">{' · '}</span>
          <span
            className="inbox-row__detail"
            data-testid={DETAIL_TEST_IDS[status.rung]}
            title={status.detail}
          >
            {status.detail}
          </span>
        </>
      )}
      {status.since !== undefined && (
        <>
          {/* The ticking number is for the eye only. This line is the row
              button's description; a value that changes every second would
              be re-read or go stale mid-sentence. */}
          <span aria-hidden="true">
            <span className="inbox-row__sep">{' · '}</span>
            <span className="inbox-row__elapsed">
              <TickingElapsed since={status.since} />
            </span>
          </span>
          <span className="sr-only">
            {`, ${coarseDuration(now - status.since)}`}
          </span>
        </>
      )}
      {status.since === undefined && lastActivityAt !== undefined && (
        <span className="inbox-row__recency" title="Last activity">
          <span aria-hidden="true"> · {relativeTime(lastActivityAt, now)}</span>
          <span className="sr-only">
            , last activity {relativeTime(lastActivityAt, now)}
          </span>
        </span>
      )}
    </span>
  );
}

const CHIP_GLYPHS: Record<
  InboxRowChipKind,
  (props: { className?: string }) => React.ReactElement
> = {
  remote: MonitorGlyph,
  draft: EditGlyph,
  woke: TimeGlyph,
};

/** Renders nothing for an empty list: a row with no facts has no chip line. */
export function InboxRowChips({ chips }: { chips: readonly InboxRowChip[] }) {
  if (chips.length === 0) return null;
  return (
    <span className="inbox-row__chips" data-testid="inbox-row-chips">
      {chips.map((chip) => {
        const Glyph = CHIP_GLYPHS[chip.kind];
        return (
          <span
            key={chip.kind}
            className={`inbox-row__chip inbox-row__chip--${chip.kind}`}
            data-chip={chip.kind}
            title={chip.label}
          >
            <Glyph />
            <bdi>{chip.label}</bdi>
          </span>
        );
      })}
    </span>
  );
}
