import type { HomeWorkItem } from '../../views/home/home-view-model';
import { SNOOZE_ACTION_LABEL, snoozeChoices } from './snooze-presets';

type SelectAction = (trigger: HTMLButtonElement) => void;

interface ActionLabel {
  label: string;
  accessibleLabel: string;
}

export interface InboxRowCommand extends ActionLabel {
  kind: 'command';
  id: 'open' | 'done' | 'discard-unsent';
  icon: 'open' | 'done' | 'reopen' | 'discard';
  pending?: boolean;
  danger?: boolean;
  select: SelectAction;
}

export interface InboxRowSnoozeAction extends ActionLabel {
  kind: 'snooze';
  id: 'snooze';
  isSnoozed: boolean;
  choices: () => { label: string; hint: string; wakeAt: number }[];
  choose: (wakeAt: number | null, trigger: HTMLButtonElement) => void;
}

interface InboxRowDiscardAction extends ActionLabel {
  kind: 'discard';
  id: 'discard';
  threadId: string;
  onDiscarded: SelectAction;
}

export type InboxRowAction =
  | InboxRowCommand
  | InboxRowSnoozeAction
  | InboxRowDiscardAction;

/**
 * The row menu, in its one order: Open chat, Mark done (Reopen once done),
 * Snooze (Wake now once snoozed), then Discard draft. Mark done is one verb
 * whatever the host does underneath (settle, hide on the host, or dismiss on
 * this device); the host decides which, so the words never do.
 */
export function inboxRowActions({
  title,
  now,
  open,
  task = false,
  done,
  snooze,
  discardUnsent,
  discard,
}: {
  title: string;
  now: number;
  open?: SelectAction;
  /** A Task row opens a task, not a chat. */
  task?: boolean;
  done?: { done: boolean; pending?: boolean; select: SelectAction };
  snooze?: {
    isSnoozed: boolean;
    choose: InboxRowSnoozeAction['choose'];
  };
  /** This device's unsent composer text for the row's chat. */
  discardUnsent?: SelectAction;
  /** A Draft conversation, discarded on the server. */
  discard?: { threadId: string; onDiscarded: SelectAction };
}): InboxRowAction[] {
  const actions: InboxRowAction[] = [];
  if (open) {
    const label = task ? 'Open task' : 'Open chat';
    actions.push({
      kind: 'command',
      id: 'open',
      label,
      accessibleLabel: `${label} ${title}`,
      icon: 'open',
      select: open,
    });
  }
  if (done) {
    actions.push({
      kind: 'command',
      id: 'done',
      label: done.done ? 'Reopen' : 'Mark done',
      accessibleLabel: done.done ? `Reopen ${title}` : `Mark ${title} done`,
      icon: done.done ? 'reopen' : 'done',
      pending: done.pending,
      select: done.select,
    });
  }
  if (snooze) {
    actions.push({
      kind: 'snooze',
      id: 'snooze',
      label: snooze.isSnoozed ? 'Wake now' : SNOOZE_ACTION_LABEL,
      accessibleLabel: snooze.isSnoozed
        ? `Wake ${title} now`
        : `Snooze ${title}`,
      isSnoozed: snooze.isSnoozed,
      choices: () => snoozeChoices(now),
      choose: snooze.choose,
    });
  }
  if (discardUnsent) {
    actions.push({
      kind: 'command',
      id: 'discard-unsent',
      label: 'Discard draft',
      accessibleLabel: `Discard draft for ${title}`,
      icon: 'discard',
      danger: true,
      select: discardUnsent,
    });
  }
  if (discard) {
    actions.push({
      kind: 'discard',
      id: 'discard',
      label: 'Discard draft',
      accessibleLabel: `Discard draft ${title}`,
      ...discard,
    });
  }
  return actions;
}

export function inboxRowCopyTargets(item: HomeWorkItem) {
  const primaryLabel = item.kind === 'task' ? 'Task ID' : 'Chat ID';
  const primary = item.kind === 'task' ? item.id : item.conversationId;
  const session =
    item.kind === 'task' ? item.taskSessionId : item.orchestrationThreadId;
  return [
    ...(primary
      ? [{ key: 'primary-id', label: primaryLabel, value: primary }]
      : []),
    ...(session && session !== primary
      ? [{ key: 'session-id', label: 'Session ID', value: session }]
      : []),
  ];
}
