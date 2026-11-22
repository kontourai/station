import { formatDuration } from '../../utils/relativeTime';
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
  TargetGlyph,
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
  'delivery-unconfirmed': WarningGlyph,
  blocked: LockGlyph,
  interrupted: WarningGlyph,
  failed: CloseGlyph,
  stopped: CloseGlyph,
  unanswerable: InfoGlyph,
  childWork: PeopleGlyph,
  // A clock, never the play triangle: this run is not visibly progressing.
  quiet: TimeGlyph,
  scheduled: TimeGlyph,
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

/** Keep the ticking visual out of the accessible name. The list supplies a coarse description. */
export function InboxRowDuration({
  since,
  now,
  durationId,
  standalone = false,
}: {
  since: number;
  now: number;
  durationId?: string;
  standalone?: boolean;
}) {
  const description = `for ${formatDuration(now - since, 'coarse')}`;
  return (
    <>
      <span aria-hidden="true" className="inbox-row__elapsed">
        {standalone ? 'for ' : <span className="inbox-row__sep">{' · '}</span>}
        <ElapsedDuration since={since} />
      </span>
      <span
        id={durationId}
        className="sr-only"
        aria-hidden={durationId ? true : undefined}
      >
        {durationId ? description : `, ${description}`}
      </span>
    </>
  );
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

/** Failure and unknown child custody need a visible reason on touch lists. */
const REASON_RUNGS: ReadonlySet<WorkStatusRung> = new Set([
  'failed',
  'childWork',
]);

export function CompactStatusExplanation({
  status,
  reasonId,
}: {
  status: WorkStatus;
  reasonId: string;
}) {
  return (
    <>
      {status.reason && (
        <span
          id={reasonId}
          className="sr-only"
          data-testid={REASON_TEST_IDS[status.rung]}
          title={status.reason}
        >
          {status.reason}
        </span>
      )}
      {status.detail && (
        <span
          className={
            REASON_RUNGS.has(status.rung) ? 'inbox-row__reason' : 'sr-only'
          }
          data-testid={DETAIL_TEST_IDS[status.rung]}
          title={status.detail}
        >
          {status.detail}
        </span>
      )}
    </>
  );
}

/**
 * The row's single status line: icon, word, then whatever the ladder says
 * the word is about, then a ticking duration while a turn is open.
 */
export function InboxRowStatusLine({
  status,
  now,
  id,
  reasonId,
  durationId,
}: {
  status: WorkStatus;
  now: number;
  id: string;
  /** References from a control whose visible content already includes the status. */
  reasonId?: string;
  durationId?: string;
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
          {!reasonId && <span className="sr-only">{' · '}</span>}
          <span
            id={reasonId}
            className="sr-only"
            aria-hidden={reasonId ? true : undefined}
            data-testid={REASON_TEST_IDS[status.rung]}
            title={status.reason}
          >
            {status.reason}
          </span>
        </>
      )}
      {status.detail && (
        <>
          {' '}
          <span className="inbox-row__sep">·</span>{' '}
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
        <InboxRowDuration
          since={status.since}
          now={now}
          durationId={durationId}
        />
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
  woke: TimeGlyph,
  claim: TargetGlyph,
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
            title={chip.title ?? chip.label}
          >
            <Glyph /> <bdi>{chip.label}</bdi>
          </span>
        );
      })}
    </span>
  );
}
