import { useEffect, useState } from 'react';
import {
  formatElapsed,
  type WorkStatus,
  type WorkStatusRung,
} from '../../views/home/work-status';
import {
  BranchGlyph,
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
 * A duration that ticks once a second. Starts from the injected `now`, so
 * the first paint equals the ladder's own `line`, then advances by wall-clock
 * time elapsed since. Text only: nothing here animates.
 */
function TickingElapsed({ since, now }: { since: number; now: number }) {
  const [elapsed, setElapsed] = useState(0);
  // Re-anchored whenever the host hands down a fresh `now`, so the offset is
  // only ever the time since THAT reading and is never counted twice.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `now` is the anchor this effect resets on.
  useEffect(() => {
    const anchoredAt = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Date.now() - anchoredAt), 1000);
    return () => clearInterval(timer);
  }, [now]);
  return <>{formatElapsed(now + elapsed - since)}</>;
}

/** The detail's test id names what it is the basis for, where one exists. */
const DETAIL_TEST_IDS: Partial<Record<WorkStatusRung, string>> = {
  unanswerable: 'inbox-row-answerability',
  failed: 'inbox-row-failure-reason',
  stopped: 'inbox-row-failure-reason',
};

/**
 * The row's single status line: icon, word, then whatever the ladder says
 * the word is about, then a ticking duration while a turn is open.
 */
export function InboxRowStatusLine({
  status,
  now,
  showUnread,
  id,
}: {
  status: WorkStatus;
  now: number;
  /** The row decides: the chat on screen is not unread. */
  showUnread: boolean;
  id: string;
}) {
  return (
    <span
      id={id}
      className="inbox-row__status"
      data-tone={status.tone}
      data-testid="inbox-row-status"
    >
      <InboxRowStatusGlyph rung={status.rung} />
      {showUnread && (
        <span className="inbox-row__unread">
          <span className="sr-only">Unread. </span>
        </span>
      )}
      <span className="inbox-row__word">{status.word}</span>
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
          <span className="inbox-row__sep">{' · '}</span>
          <span className="inbox-row__elapsed">
            <TickingElapsed since={status.since} now={now} />
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
  branch: BranchGlyph,
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
