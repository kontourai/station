import { absoluteTime, relativeTime } from '../../utils/relativeTime';
import {
  type WorkStatus,
  type WorkStatusRung,
  workStatusText,
} from '../../views/home/work-status';
import { ElapsedDuration } from '../ElapsedDuration';
import {
  CheckGlyph,
  CloseGlyph,
  EditGlyph,
  HandGlyph,
  InboxGlyph,
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
 * The ladder's `line` as rendered text, with its duration counted off the
 * shared clock instead of frozen at the caller's `now`. Surfaces that print
 * the whole line in one run of text (the Activity row, the hover card) use
 * this, so they show the same number as the inbox row beside them.
 */
export function WorkStatusLineText({ status }: { status: WorkStatus }) {
  const text = workStatusText(status);
  if (status.since === undefined) return <>{text}</>;
  return (
    <>
      {text}
      {' · '}
      <ElapsedDuration since={status.since} />
    </>
  );
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
  failed: 'inbox-row-failure-reason',
};

/**
 * The ladder's `reason` is never drawn on the row (the hover card and the
 * Details sheet show it), but it stays the row's accessible description:
 * archive#1783 requires the unanswerable basis to be reachable from the row,
 * and a screen reader reaches it here. The test id names what it is.
 */
const REASON_TEST_IDS: Partial<Record<WorkStatusRung, string>> = {
  unanswerable: 'inbox-row-answerability',
  stopped: 'inbox-row-failure-reason',
};

/**
 * The one rung whose detail is a REASON the user needs in full on the row:
 * why it failed. For it the fixed one-line budget yields: the line may wrap
 * to two lines rather than cut the cause off. The whole text is always in
 * the DOM, so the row's `aria-describedby` reads all of it, and the row's
 * details surface shows it unclamped.
 */
const REASON_RUNGS: ReadonlySet<WorkStatusRung> = new Set(['failed']);

/**
 * The row's single status line: icon, word, then whatever the ladder says
 * the word is about, then a ticking duration while a turn is open.
 */
export function InboxRowStatusLine({
  status,
  now,
  id,
  lastActivityAt,
}: {
  status: WorkStatus;
  now: number;
  id: string;
  /**
   * A host that hides the row's time slot (the phone picker puts the status
   * where the time was) hands the time here, and it trails the line in the
   * same compact form the slot would show. Never while a turn is open: the
   * ticking duration is that line's one number.
   */
  lastActivityAt?: number;
}) {
  const wraps = REASON_RUNGS.has(status.rung) && Boolean(status.detail);
  return (
    <span
      id={id}
      className={`inbox-row__status${wraps ? ' inbox-row__status--reason' : ''}`}
      data-tone={status.tone}
      data-testid="inbox-row-status"
      title={status.reason}
    >
      <InboxRowStatusGlyph rung={status.rung} />
      <span className="inbox-row__word">{status.word}</span>
      {status.reason && (
        <>
          <span className="sr-only">{' · '}</span>
          <span
            className="sr-only"
            data-testid={REASON_TEST_IDS[status.rung]}
            title={status.reason}
          >
            {status.reason}
          </span>
        </>
      )}
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
      {status.since === undefined && lastActivityAt !== undefined && (
        // One element with its separator, like the elapsed time below: the
        // phone picker hides the line's direct separators (it folds the
        // detail away), and the time keeps its dot the way the duration does.
        <span>
          <span className="inbox-row__sep">{' · '}</span>
          <span
            className="inbox-row__recency"
            title={absoluteTime(lastActivityAt)}
          >
            {relativeTime(lastActivityAt, now)}
          </span>
        </span>
      )}
      {status.since !== undefined && (
        <>
          {/* The ticking number is for the eye only. This line is the row
              button's description; a value that changes every second would
              be re-read or go stale mid-sentence. */}
          <span aria-hidden="true">
            <span className="inbox-row__sep">{' · '}</span>
            <span className="inbox-row__elapsed">
              {/* The shared clock, never the list's coarse `now`: that
                  advances every 30 seconds, so anchoring to it showed "0s"
                  for a turn already 20-30 seconds old, and a second surface
                  on its own clock read a different number for the same
                  turn. */}
              <ElapsedDuration since={status.since} />
            </span>
          </span>
          <span className="sr-only">
            {`, ${coarseDuration(now - status.since)}`}
          </span>
        </>
      )}
    </span>
  );
}

const CHIP_GLYPHS: Record<
  InboxRowChipKind,
  (props: { className?: string }) => React.ReactElement
> = {
  'agent-message': InboxGlyph,
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
