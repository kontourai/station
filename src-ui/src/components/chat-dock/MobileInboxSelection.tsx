import { useLayoutEffect, useRef, useState } from 'react';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import type { WorkFactsById } from '../../views/home/work-facts';
import { ActionOverflowMenu } from '../ActionOverflowMenu';
import { Button } from '../Button';
import { CheckGlyph, CloseGlyph, TimeGlyph } from '../icons/Glyph';
import {
  type MobileActivityGroup,
  SNOOZE_OPTIONS,
  snoozeWakeAt,
} from './mobile-activity-groups';
import { inboxResolutionId } from './mobile-inbox-selection';
import { useConversationWorkState } from './useConversationWorkState';

type Entry = { item: HomeWorkItem; group: MobileActivityGroup['id'] };
export function MobileInboxSelection({
  selected,
  groups,
  facts,
  onChange,
  snooze,
  dismiss,
  isCurrent,
  details,
}: {
  selected: ReadonlySet<string>;
  groups: MobileActivityGroup[];
  facts?: WorkFactsById;
  onChange(ids: Set<string> | null): void;
  isCurrent(): boolean;
  snooze(item: HomeWorkItem, wakeAt: number, trigger: HTMLButtonElement): void;
  dismiss(item: HomeWorkItem): Promise<void>;
  details(item: HomeWorkItem): void;
}) {
  const work = useConversationWorkState();
  const busy = useRef(false);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const available = new Map<string, Entry>();
  for (const group of groups) {
    for (const root of [...group.items, ...(group.older ?? [])]) {
      for (const item of [root, ...(group.childrenById?.get(root.id) ?? [])])
        if (selected.has(item.id))
          available.set(item.id, { item, group: group.id });
    }
  }
  const entries = [...available.values()];
  const maySettle = (entry: Entry) =>
    !!inboxResolutionId(
      entry.item,
      facts?.get(entry.item.id),
      work.supported,
    ) &&
    entry.group !== 'dismissed' &&
    entry.group !== 'settled' &&
    !Object.hasOwn(work.settled, entry.item.conversationId!);
  const mayDismiss = (entry: Entry) =>
    entry.group !== 'dismissed' &&
    (entry.group === 'settled' ||
      entry.item.controlMode === 'read-only-attached');
  const canSettle =
    !!entries.length &&
    !work.change.isPending &&
    !!work.change.mutateAsync &&
    entries.every(maySettle);
  const canDismiss = !!entries.length && entries.every(mayDismiss);
  const canSnooze =
    !!entries.length &&
    entries.every(
      (entry) => entry.group !== 'snoozed' && entry.group !== 'dismissed',
    );
  const current = useRef({ available, maySettle, mayDismiss, isCurrent });
  current.current = { available, maySettle, mayDismiss, isCurrent };
  const apply = async (
    operation: 'settle' | 'dismiss' | 'snooze',
    trigger: HTMLButtonElement,
    wakeAt?: number,
  ) => {
    if (busy.current || !entries.length) return;
    busy.current = true;
    setPending(true);
    setNotice('');
    const failed = new Set<string>();
    for (const { item } of entries) {
      if (!mounted.current) return;
      const fresh = current.current.available.get(item.id);
      if (!current.current.isCurrent() || !fresh) {
        failed.add(item.id);
        continue;
      }
      try {
        if (
          operation === 'settle' &&
          current.current.maySettle(fresh) &&
          fresh.item.conversationId &&
          work.change.mutateAsync
        ) {
          await work.change.mutateAsync({
            conversationId: fresh.item.conversationId,
            settled: true,
          });
        } else if (operation === 'dismiss' && current.current.mayDismiss(fresh))
          await dismiss(fresh.item);
        else if (
          operation === 'snooze' &&
          wakeAt !== undefined &&
          fresh.group !== 'snoozed' &&
          fresh.group !== 'dismissed'
        )
          snooze(fresh.item, wakeAt, trigger);
        else failed.add(item.id);
      } catch {
        failed.add(item.id);
      }
    }
    if (!mounted.current) return;
    busy.current = false;
    setPending(false);
    if (!current.current.isCurrent()) return;
    if (failed.size) {
      onChange(failed);
      setNotice(`Couldn’t update ${failed.size} selected. Try again.`);
    } else onChange(null);
  };
  return (
    <section
      className="mobile-inbox-selection"
      aria-label="Selected conversations"
    >
      <div className="mobile-inbox-selection__summary">
        {entries.length === 1 && (
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => details(entries[0].item)}
          >
            Details
          </Button>
        )}
      </div>
      <div className="mobile-inbox-selection__commands">
        <ActionOverflowMenu
          label="Snooze selected conversations"
          triggerText="Snooze"
          triggerGlyph={<TimeGlyph />}
          actions={SNOOZE_OPTIONS.map((option) => ({
            key: option.label,
            label: option.label,
            disabled: pending || !canSnooze,
            onSelect: (trigger) => {
              if (trigger instanceof HTMLButtonElement)
                void apply('snooze', trigger, snoozeWakeAt(option, Date.now()));
            },
          }))}
        />
        <Button
          disabled={pending || !canSettle}
          onClick={(e) => void apply('settle', e.currentTarget)}
        >
          <CheckGlyph />
          Settle
        </Button>
        <Button
          disabled={pending || !canDismiss}
          onClick={(e) => void apply('dismiss', e.currentTarget)}
        >
          <CloseGlyph />
          Dismiss
        </Button>
      </div>
      <small role="status">
        {notice ||
          (!entries.length
            ? 'Select conversations to update.'
            : !canSettle
              ? work.supported
                ? 'Settle is available after work finishes and requests are answered.'
                : 'Settle requires the Open and Settled inbox preview.'
              : !canDismiss
                ? 'Dismiss applies to settled or imported items.'
                : '')}
      </small>
    </section>
  );
}
