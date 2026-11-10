import {
  SNOOZE_OPTIONS,
  snoozeWakeAt,
} from '../chat-dock/mobile-activity-groups';

type SelectAction = (trigger: HTMLButtonElement) => void;

interface ActionLabel {
  label: string;
  shortLabel: string;
  accessibleLabel: string;
}

export interface InboxRowCommand extends ActionLabel {
  kind: 'command';
  id: 'resolution' | 'close' | 'restore' | 'discard-unsent';
  icon: 'settle' | 'reopen' | 'close' | 'restore' | 'discard';
  pending?: boolean;
  danger?: boolean;
  select: SelectAction;
}

export interface InboxRowSnoozeAction extends ActionLabel {
  kind: 'snooze';
  id: 'snooze';
  isSnoozed: boolean;
  choices: { label: string; wakeAt: number }[];
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

export function inboxRowActions({
  title,
  now,
  snooze,
  close,
  restore,
  resolution,
  discardUnsent,
  discard,
}: {
  title: string;
  now: number;
  snooze?: {
    isSnoozed: boolean;
    choose: InboxRowSnoozeAction['choose'];
  };
  close?: { dismiss: boolean; select: SelectAction };
  restore?: SelectAction;
  resolution?: {
    settled: boolean;
    pending: boolean;
    select: SelectAction;
  };
  discardUnsent?: SelectAction;
  discard?: { threadId: string; onDiscarded: SelectAction };
}): InboxRowAction[] {
  const actions: InboxRowAction[] = [];
  if (resolution) {
    const verb = resolution.settled ? 'Reopen' : 'Settle';
    actions.push({
      kind: 'command',
      id: 'resolution',
      label: `${verb} conversation`,
      shortLabel: verb,
      accessibleLabel: `${verb} ${title}`,
      icon: resolution.settled ? 'reopen' : 'settle',
      pending: resolution.pending,
      select: resolution.select,
    });
  }
  if (snooze) {
    const label = snooze.isSnoozed ? 'Unsnooze' : 'Snooze';
    actions.push({
      kind: 'snooze',
      id: 'snooze',
      label,
      shortLabel: label,
      accessibleLabel: `${label} ${title}`,
      isSnoozed: snooze.isSnoozed,
      choices: SNOOZE_OPTIONS.map((option) => ({
        label: option.label,
        wakeAt: snoozeWakeAt(option, now),
      })),
      choose: snooze.choose,
    });
  }
  if (restore) {
    actions.push({
      kind: 'command',
      id: 'restore',
      label: 'Restore to inbox',
      shortLabel: 'Restore',
      accessibleLabel: `Restore ${title} to inbox`,
      icon: 'restore',
      select: restore,
    });
  }
  if (close) {
    actions.push({
      kind: 'command',
      id: 'close',
      label: close.dismiss ? 'Dismiss from inbox' : 'Close chat',
      shortLabel: close.dismiss ? 'Dismiss' : 'Close',
      accessibleLabel: close.dismiss
        ? `Dismiss ${title} from inbox`
        : `Close ${title}`,
      icon: 'close',
      select: close.select,
    });
  }
  if (discardUnsent) {
    actions.push({
      kind: 'command',
      id: 'discard-unsent',
      label: 'Discard unsent draft',
      shortLabel: 'Discard draft',
      accessibleLabel: `Discard unsent draft for ${title}`,
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
      shortLabel: 'Discard draft',
      accessibleLabel: `Discard draft ${title}`,
      ...discard,
    });
  }
  return actions;
}
