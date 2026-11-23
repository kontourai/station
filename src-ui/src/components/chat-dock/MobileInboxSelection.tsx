import { useLayoutEffect, useRef, useState } from 'react';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import type { WorkFactsById } from '../../views/home/work-facts';
import { ActionOverflowMenu } from '../ActionOverflowMenu';
import { Button } from '../Button';
import { CheckGlyph, TimeGlyph } from '../icons/Glyph';
import { snoozeChoices } from '../inbox-row/snooze-presets';
import { offerInboxUndo } from './inbox-dismissals';
import type { MobileActivityGroup } from './mobile-activity-groups';
import { inboxResolutionId } from './mobile-inbox-selection';
import { useConversationWorkState } from './useConversationWorkState';

type Entry = { item: HomeWorkItem; group: MobileActivityGroup['id'] };
/** How one selected row was marked done, so Undo reverses exactly that. */
type Done =
  | { kind: 'settled'; conversationId: string }
  | { kind: 'dismissed'; item: HomeWorkItem };
export function MobileInboxSelection({
  selected,
  groups,
  facts,
  onChange,
  snooze,
  dismiss,
  restore,
  isCurrent,
  details,
}: {
  selected: ReadonlySet<string>;
  groups: MobileActivityGroup[];
  facts?: WorkFactsById;
  onChange(ids: Set<string> | null): void;
  isCurrent(): boolean;
  snooze(item: HomeWorkItem, wakeAt: number, trigger: HTMLButtonElement): void;
  /** Mark done on this device, or hide a third-party Session on the host. */
  dismiss(item: HomeWorkItem): Promise<void>;
  /** Reopen a row `dismiss` marked done. */
  restore(item: HomeWorkItem): void;
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
  /** The settlement Mark done uses for this row, when it reaches it. */
  const settleId = (entry: Entry) =>
    inboxResolutionId(entry.item, facts?.get(entry.item.id), work.supported);
  // Mark done: settle where settlement reaches the row, else dismiss on this
  // device; a row already done (Settled, or marked done) has nothing to do.
  const mayMarkDone = (entry: Entry) =>
    entry.group !== 'dismissed' &&
    entry.group !== 'settled' &&
    !(
      settleId(entry) &&
      Object.hasOwn(work.settled, entry.item.conversationId ?? '')
    ) &&
    (!settleId(entry) || !!work.change.mutateAsync);
  const canMarkDone =
    !!entries.length && !work.change.isPending && entries.every(mayMarkDone);
  const canSnooze =
    !!entries.length &&
    entries.every(
      (entry) => entry.group !== 'snoozed' && entry.group !== 'dismissed',
    );
  const current = useRef({ available, mayMarkDone, settleId, isCurrent });
  current.current = { available, mayMarkDone, settleId, isCurrent };
  const apply = async (
    operation: 'done' | 'snooze',
    trigger: HTMLButtonElement,
    wakeAt?: number,
  ) => {
    if (busy.current || !entries.length) return;
    busy.current = true;
    setPending(true);
    setNotice('');
    const failed = new Set<string>();
    const done: Done[] = [];
    for (const { item } of entries) {
      if (!mounted.current) return;
      const fresh = current.current.available.get(item.id);
      if (!current.current.isCurrent() || !fresh) {
        failed.add(item.id);
        continue;
      }
      try {
        const conversationId = current.current.settleId(fresh);
        if (operation === 'done' && current.current.mayMarkDone(fresh)) {
          if (conversationId && work.change.mutateAsync) {
            await work.change.mutateAsync({ conversationId, settled: true });
            done.push({ kind: 'settled', conversationId });
          } else {
            await dismiss(fresh.item);
            done.push({ kind: 'dismissed', item: fresh.item });
          }
        } else if (
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
    // What was marked done stays undoable, with its notice and ⌘Z, even
    // when some of the selection failed.
    if (done.length)
      offerInboxUndo(
        done.length === 1 ? 'Marked done' : `${done.length} marked done`,
        () => {
          for (const entry of done) {
            if (entry.kind === 'settled')
              work.change.mutate({
                conversationId: entry.conversationId,
                settled: false,
              });
            else restore(entry.item);
          }
        },
      );
    if (!mounted.current) return;
    busy.current = false;
    setPending(false);
    if (!current.current.isCurrent()) return;
    if (failed.size) {
      onChange(failed);
      setNotice(`Couldn’t update ${failed.size} selected. Try again.`);
    } else onChange(null);
  };
  const snoozeLabel = (
    <>
      <TimeGlyph />
      <span>Snooze</span>
    </>
  );
  return (
    <section
      className="mobile-inbox-selection"
      aria-label="Selected conversations"
    >
      <div className="mobile-inbox-selection__commands">
        <ActionOverflowMenu
          disabled={pending || !canSnooze}
          label="Snooze selected conversations"
          triggerClassName="mobile-inbox-selection__action"
          triggerGlyph={snoozeLabel}
          actions={snoozeChoices(Date.now()).map((choice) => ({
            key: choice.label,
            label: `${choice.label} · ${choice.hint}`,
            onSelect: (trigger) => {
              if (trigger instanceof HTMLButtonElement)
                void apply('snooze', trigger, choice.wakeAt);
            },
          }))}
        />

        <Button
          variant="ghost"
          className="mobile-inbox-selection__action"
          disabled={pending || !canMarkDone}
          onClick={(e) => void apply('done', e.currentTarget)}
        >
          <span>
            <CheckGlyph />
            <span>Mark done</span>
          </span>
        </Button>
      </div>
      <div className="mobile-inbox-selection__meta">
        <small role="status">
          {notice ||
            (!entries.length
              ? 'Select conversations to update.'
              : !entries.every(mayMarkDone)
                ? 'Some of these are already done.'
                : '')}
        </small>
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
    </section>
  );
}
