import { type ReactNode, useCallback, useId, useRef, useState } from 'react';
import { ComposerChoice } from './ComposerChoice';
import { ComposerChoiceSummary } from './ComposerChoiceSummary';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from './ResponsiveDialogSurface';
import { Skeleton } from './state';
import './ComposerRunControl.css';

/** One setup entry point for replies and every start surface. Picker owners stay mounted. */
export function ComposerRunControl({
  label,
  icon,
  children,
  loadingLabel,
}: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
  loadingLabel?: string;
}) {
  const contentId = useId();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const publish = useCallback((id: string, label: string | undefined) => {
    setSummaries((current) => {
      if (current[id] === label) return current;
      const next = { ...current };
      if (label === undefined) delete next[id];
      else next[id] = label;
      return next;
    });
  }, []);
  const sectionOrder = (value: string) =>
    /^Agent:/.test(value)
      ? 0
      : /^(Approval|Permissions)/.test(value)
        ? 2
        : /^Session mode:/.test(value)
          ? 3
          : 1;
  const labels = Object.values(summaries).sort(
    (a, b) => sectionOrder(a) - sectionOrder(b),
  );
  const summary = [
    ...labels,
    ...(!labels.some((value) => /^Agent:/.test(value))
      ? ['Agent: current selection']
      : []),
    ...(!labels.some((value) =>
      /^(Model:|Engine & model:|.*model:)/i.test(value),
    )
      ? [`Model: ${label}`]
      : []),
    ...(!labels.some((value) => /^(Approval|Permissions)/.test(value))
      ? ['Approval: engine default']
      : []),
    ...(!labels.some((value) => /^Session mode:/.test(value))
      ? ['Mode: engine default']
      : []),
  ].join('; ');
  return (
    <>
      {loadingLabel ? (
        <span role="status" aria-label={loadingLabel}>
          <Skeleton variant="line" width="9rem" />
        </span>
      ) : (
        <ComposerChoice
          ref={trigger}
          className="composer-run-control"
          caption="Run setup"
          value={label}
          icon={icon}
          aria-label={`Run setup: ${summary}`}
          aria-haspopup="dialog"
          aria-controls={contentId}
          aria-expanded={open}
          onClick={() => setOpen(true)}
        />
      )}
      <ResponsiveDialogSurface
        open={open}
        layer="popover"
        ariaLabel="Run setup"
        onClose={() => setOpen(false)}
        anchorRef={trigger}
        returnFocusTarget={trigger.current}
        overlayClassName="composer-popover-overlay composer-popover-overlay--start"
        panelClassName="composer-popover-panel composer-run-panel"
      >
        <ResponsiveDialogHeader
          title="Run setup"
          closeLabel="Close run setup"
          onClose={() => setOpen(false)}
        />
        <ComposerChoiceSummary.Provider value={publish}>
          <div id={contentId} className="composer-run-panel__choices">
            {children}
          </div>
        </ComposerChoiceSummary.Provider>
      </ResponsiveDialogSurface>
    </>
  );
}
