/**
 * Pull request agent feedback that needs a person: a pause (rounds on one
 * head, messages in 24 hours, the same checks failing on several pushes) or
 * a chat whose agent stopped with feedback waiting. The words the Needs-you
 * item and the one push notification use, and the push itself.
 *
 * Copy is honest about what lifts a pause: Send again, turning feedback off,
 * or a new head with different feedback. Nothing here says it resumes on its
 * own, because a pause does not.
 */
import { createHash } from 'node:crypto';
import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import type { NotificationEnvelopeV1 } from '@kontourai/station-contracts/notification';
import {
  describePullRequestFeedbackCategories,
  type PullRequestFeedbackCategoryCount,
} from '@kontourai/station-contracts/pull-request-feedback';
import type { NotificationService } from '../notifications/notification-service.js';

/**
 * The notification source (and category) of a feedback notice. One line on
 * purpose: the internal-sources scan resolves `const NAME = '…'` at the call.
 */
const NOTICE_SOURCE = 'pull-request-feedback';
export const PULL_REQUEST_FEEDBACK_NOTIFICATION_SOURCE = NOTICE_SOURCE;

type NoticeReason =
  | 'round-limit'
  | 'repeated-failure'
  | 'fix-budget'
  | 'agent-stopped';

/** What delivery reports once when feedback starts needing a person. */
export interface PullRequestFeedbackNotice {
  conversationId: string;
  prKey: string;
  identity: PullRequestLinkIdentity;
  reason: NoticeReason;
  cap?: 'head' | 'day';
  headSha: string;
  /**
   * When this pause began, or when the oldest feedback waiting on a stopped
   * agent was recorded: what makes one notice one pause or one stop.
   */
  at: string;
  /** Failing check names, required checks first. */
  failing?: string[];
  /** cap head: rounds that head had. */
  rounds?: number;
  /** agent-stopped: what is waiting. */
  waiting?: PullRequestFeedbackCategoryCount[];
  /**
   * Only "Review each new head" is on: what paused is review findings, not
   * auto-fix.
   */
  reviewOnly?: true;
}

/** One pull request whose feedback needs a person, for the attention item. */
export interface PullRequestFeedbackAttentionSource
  extends PullRequestFeedbackNotice {
  /** The owning chat's current Session: who may read it decides who sees it. */
  sessionId: string;
  url?: string;
}

const SHA = /^[0-9a-f]{7,64}$/i;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const CHECK_NAME_CHARS = 60;
const MAX_ROUNDS_PER_HEAD = 3;
const MAX_SENT_PER_DAY = 10;
const REPEATED_FAILURE_HEADS = 3;

const short = (sha: string) => (SHA.test(sha) ? sha.slice(0, 7) : 'its head');
const paused = (notice: Pick<PullRequestFeedbackNotice, 'reviewOnly'>) =>
  notice.reviewOnly ? 'Review feedback is paused.' : 'Auto-fix is paused.';
const number = (identity: PullRequestLinkIdentity) =>
  /^\d{1,12}$/.test(identity.ref) ? `#${identity.ref}` : 'A pull request';
const repository = (identity: PullRequestLinkIdentity) =>
  NAME.test(identity.repository.owner) && NAME.test(identity.repository.name)
    ? `${identity.repository.owner}/${identity.repository.name}`
    : 'The repository';

/** Forge text on one line, bounded. */
function checkName(name: string): string {
  const line = name.replace(/\s+/g, ' ').trim();
  return line.length > CHECK_NAME_CHARS
    ? `${line.slice(0, CHECK_NAME_CHARS - 1)}…`
    : line || 'A check';
}

/** "a and b", or "a, b and 3 more". */
function checkNames(names: readonly string[]): string {
  const shown = names.slice(0, 2).map(checkName);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  return shown.join(' and ') || 'The same checks';
}

const prDigest = (prKey: string) =>
  createHash('sha256').update(prKey).digest('hex').slice(0, 16);

/** The attention item's id: one per pull request, versioned by `updatedAt`. */
export function pullRequestFeedbackAttentionId(prKey: string): string {
  return `pull-request-feedback:${prDigest(prKey)}`;
}

/**
 * The dedupe tag of one notice: one record per pause or stop (its `at`), so
 * a later pause on the same head is a new notice, and a restart noticing the
 * same stop again finds the one it already wrote.
 */
export function pullRequestFeedbackNoticeTag(
  prKey: string,
  reason: NoticeReason,
  at: string,
): string {
  const version = createHash('sha256').update(at).digest('hex').slice(0, 12);
  return `pr-feedback:${prDigest(prKey)}:${reason}:${version}`;
}

/**
 * Settle every feedback notice that no longer names something needing a
 * person (the pause lifted, the claim was turned off or released, the agent
 * is no longer stopped): marked expired, so it stops interrupting and the
 * channels that can take an alert back do.
 */
export async function settlePullRequestFeedbackNotices(
  notificationService: Pick<NotificationService, 'list' | 'markStatus'>,
  active: readonly PullRequestFeedbackNotice[],
): Promise<void> {
  const live = new Set(
    active.map((notice) =>
      pullRequestFeedbackNoticeTag(notice.prKey, notice.reason, notice.at),
    ),
  );
  for (const notification of await notificationService.list({
    status: ['delivered', 'pending'],
  })) {
    const tag = notification.metadata?.dedupeTag;
    if (
      notification.source === NOTICE_SOURCE &&
      typeof tag === 'string' &&
      !live.has(tag)
    )
      await notificationService.markStatus(notification.id, 'expired');
  }
}

/** "2 failing checks were" / "a merge conflict was". */
function waitingClause(waiting: readonly PullRequestFeedbackCategoryCount[]) {
  const total = waiting.reduce((sum, entry) => sum + entry.count, 0);
  return `${describePullRequestFeedbackCategories(waiting)} ${total > 1 ? 'were' : 'was'}`;
}

/** The Needs-you item's title and body. */
export function pullRequestFeedbackAttentionCopy(
  source: PullRequestFeedbackNotice,
): { title: string; body: string } {
  const pr = number(source.identity);
  const head = short(source.headSha);
  const failed = source.failing?.length
    ? `${checkNames(source.failing)} failed on ${head}.`
    : `New feedback on ${head} was not sent.`;
  switch (source.reason) {
    case 'agent-stopped':
      return {
        title: `${pr} has feedback waiting`,
        body: `Its agent stopped, so ${waitingClause(source.waiting ?? [])} not sent.`,
      };
    case 'fix-budget':
      return {
        title: `${pr}: every fix attempt is used`,
        body: `${checkNames(source.failing ?? [])} still failing on ${head}. The Task waits for you.`,
      };
    case 'repeated-failure':
      return {
        title: `${pr}: the same checks failed on ${REPEATED_FAILURE_HEADS} pushes`,
        body: `${checkNames(source.failing ?? [])} failed again on ${head}. ${paused(source)}`,
      };
    default:
      return {
        title:
          source.cap === 'day'
            ? `${pr}: ${MAX_SENT_PER_DAY} feedback messages in 24 hours`
            : source.cap === 'head'
              ? source.failing?.length
                ? `${pr} still failing after ${source.rounds ?? MAX_ROUNDS_PER_HEAD} rounds`
                : `${pr} still has feedback after ${source.rounds ?? MAX_ROUNDS_PER_HEAD} rounds`
              : `${pr}: ${source.reviewOnly ? 'review feedback' : 'auto-fix'} is paused`,
        body: `${failed} ${paused(source)}`,
      };
  }
}

const bounded = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** The push notification's title (≤80) and body (≤300). */
function pushCopy(notice: PullRequestFeedbackNotice): {
  title: string;
  body: string;
} {
  const pr = number(notice.identity);
  const where = `${repository(notice.identity)} at ${short(notice.headSha)}`;
  const rounds = notice.rounds ?? MAX_ROUNDS_PER_HEAD;
  const title =
    notice.reason === 'agent-stopped'
      ? `${pr} has feedback waiting; its agent stopped`
      : notice.reason === 'fix-budget'
        ? `${pr}: every fix attempt is used; the Task waits for you`
        : notice.reason === 'repeated-failure'
          ? `Agent paused on ${pr}: same checks failed on ${REPEATED_FAILURE_HEADS} pushes`
          : notice.cap === 'day'
            ? `Agent paused on ${pr}: ${MAX_SENT_PER_DAY} messages in 24 hours`
            : notice.failing?.length
              ? `Agent paused on ${pr}: checks still failing after ${rounds} rounds`
              : `Agent paused on ${pr} after ${rounds} rounds of feedback`;
  const body =
    notice.reason === 'agent-stopped'
      ? `${where}: ${waitingClause(notice.waiting ?? [])} not sent. Open the chat to continue.`
      : `${where}. Send again or turn off ${notice.reviewOnly ? 'review of each head' : 'auto-fix'} in Station.`;
  return { title: bounded(title, 80), body: bounded(body, 300) };
}

/**
 * Write the one push notification for a notice, to the owning Session's
 * readers. The dedupe tag makes a repeat of the same notice (a restart
 * noticing a stopped agent again) an update that does not interrupt again.
 */
export async function schedulePullRequestFeedbackNotice(
  notificationService: Pick<NotificationService, 'scheduleEnveloped'>,
  notice: PullRequestFeedbackNotice,
  sessionId: string,
): Promise<void> {
  const envelope: NotificationEnvelopeV1 = {
    v: 1,
    source: {
      kind: 'system',
      subsystem: NOTICE_SOURCE,
    },
    audience: { kind: 'session-readers', sessionId },
    urgency: 'attention',
    target: { kind: 'session', sessionId },
    interrupt: 'default',
  };
  const { title, body } = pushCopy(notice);
  await notificationService.scheduleEnveloped(
    NOTICE_SOURCE,
    {
      category: NOTICE_SOURCE,
      title,
      body,
      dedupeTag: pullRequestFeedbackNoticeTag(
        notice.prKey,
        notice.reason,
        notice.at,
      ),
      metadata: { sessionId },
    },
    envelope,
  );
}
