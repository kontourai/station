/**
 * Which of a chat's approval requests are still waiting on the USER.
 *
 * `pendingApprovals` is every request open on the server. A request the user
 * has answered from the approval queue stays open there until the engine's
 * `request.resolved` arrives, so it stays in `pendingApprovals` but also lands
 * in `answeredApprovals`: from then on it waits on the engine, not the user.
 * Every surface that says "approval needed" must subtract the answered ones,
 * or the pill, the transcript's status line, the typing dots and the inbox
 * lane disagree with each other for the window between answering and
 * resolving. They all read this one derivation.
 */
export interface ApprovalRequestState {
  pendingApprovals?: readonly string[];
  answeredApprovals?: readonly string[];
  orchestrationStatus?: string;
}

/** Requests open on the server and not yet answered here, in arrival order. */
export function requestsWaitingOnUser(chat: ApprovalRequestState): string[] {
  const answered = chat.answeredApprovals;
  return (chat.pendingApprovals ?? []).filter((id) => !answered?.includes(id));
}

/**
 * Whether the chat needs a person: a request is waiting on them, or the
 * session reports `awaiting-approval` with NO request behind it (a crashed
 * turn folds to that status; station#2235) — it is then waiting on the user,
 * not on a decision. An `awaiting-approval` session whose every open request
 * is already answered is waiting on the engine and needs nobody.
 */
export function chatWaitsOnUser(chat: ApprovalRequestState): boolean {
  if (requestsWaitingOnUser(chat).length > 0) return true;
  return (
    chat.orchestrationStatus === 'awaiting-approval' &&
    (chat.pendingApprovals?.length ?? 0) === 0
  );
}
