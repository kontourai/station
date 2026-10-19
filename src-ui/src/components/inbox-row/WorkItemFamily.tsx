import { type ReactNode, useEffect, useId, useState } from 'react';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import { workStatus } from '../../views/home/work-status';
import { DisclosureToggle } from '../DisclosureToggle';

/** Presentation only: the recorded root never inherits its children's controls. */
export function WorkItemFamily<T extends HomeWorkItem>({
  root,
  members = [],
  now,
  renderRow,
  forceExpanded = false,
  expanded: controlledExpanded,
  onExpandedChange,
  onMembersHidden,
}: {
  root: T;
  members?: readonly T[];
  now: number;
  renderRow: (item: T) => ReactNode;
  forceExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  onMembersHidden?: () => void;
}) {
  const [ownExpanded, setOwnExpanded] = useState(false);
  const expanded = controlledExpanded ?? ownExpanded;
  const setExpanded = onExpandedChange ?? setOwnExpanded;
  const id = useId();
  const needsYou = members.filter(
    (item) => workStatus(item, now).lane === 'needsYou',
  ).length;
  const open = expanded || needsYou > 0 || forceExpanded;
  useEffect(() => {
    if ((needsYou > 0 || forceExpanded) && !expanded) setExpanded(true);
  }, [needsYou, forceExpanded, expanded, setExpanded]);
  const noun =
    root.kind === 'task'
      ? members.length === 1
        ? 'session'
        : 'sessions'
      : members.length === 1
        ? 'subtask'
        : 'subtasks';
  const summary = `${members.length} ${noun}${needsYou > 0 ? ` · ${needsYou} needs you` : ''}`;
  if (members.length === 0) return renderRow(root);
  return (
    <div className="inbox-row-family">
      {renderRow(root)}
      {needsYou > 0 || forceExpanded ? (
        <p className="inbox-row-family__summary">{summary}</p>
      ) : (
        <DisclosureToggle
          expanded={open}
          controls={id}
          onToggle={() => {
            if (open) onMembersHidden?.();
            setExpanded(!open);
          }}
        >
          {summary}
        </DisclosureToggle>
      )}
      {open && (
        <section
          id={id}
          className="inbox-row-family__children"
          aria-label={`${root.kind === 'task' ? 'Sessions' : 'Subtasks'} of ${root.title}`}
        >
          {members.map((item) => (
            <div key={item.id}>{renderRow(item)}</div>
          ))}
        </section>
      )}
    </div>
  );
}
