import { type EngineId } from '@kontourai/station-contracts/agent-identity';
import {
  cloneElement,
  isValidElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { ComposerChoice } from './ComposerChoice';
import {
  ComposerChoiceSummary,
  ComposerRunSetupClose,
} from './ComposerChoiceSummary';
import { AgentIcon, agentIconEngineId } from './icons/AgentIcon';
import {
  BrandIcon,
  hasBundledEngineMark,
  resolveBrandKey,
} from './icons/BrandIcon';
import { AgentGlyph } from './icons/Glyph';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from './ResponsiveDialogSurface';
import { Skeleton } from './state';
import './ComposerRunControl.css';

/** One setup entry point for replies and every start surface. Picker owners stay mounted. */
export function ComposerRunControl({
  label,
  effort,
  icon,
  engineId,
  children,
  loadingLabel,
  notice,
  description,
  closeHandle,
}: {
  label: string;
  /** The requested reasoning effort, shown after the model; absent when the engine default applies. */
  effort?: string;
  icon: ReactNode;
  engineId?: EngineId | null;
  children: ReactNode;
  loadingLabel?: string;
  /** A short fact the closed trigger states beside its label, which gives way first. */
  notice?: string;
  /** The trigger's accessible description: the sentence behind `notice`. */
  description?: string;
  /**
   * Receives the panel's close, for a picker rendered outside the panel whose
   * choice opens a dialog that should replace it (an engine switch on a phone).
   */
  closeHandle?: { current: (() => void) | null };
}) {
  const agent =
    isValidElement<React.ComponentProps<typeof AgentIcon>>(icon) &&
    icon.type === AgentIcon
      ? icon.props.agent
      : undefined;
  const agentEngine = agent && agentIconEngineId(agent);
  // Explicit artwork wins over the engine's default mark, just as in BrandIcon.
  const agentBrand = agent?.icon?.startsWith('brand:')
    ? agent.icon.slice(6)
    : agent && !agent.icon && !agent.iconUrl && agentEngine
      ? resolveBrandKey(agentEngine)
      : undefined;
  const engineBrand = engineId && resolveBrandKey(engineId);
  const mark =
    agent && isValidElement<React.ComponentProps<typeof AgentIcon>>(icon)
      ? cloneElement(icon, { fallbackGlyph: true })
      : icon || <AgentGlyph />;
  const separator = label.lastIndexOf(' · ');
  // Effort qualifies a Model, so it is shown only beside one.
  const shownEffort = separator < 0 ? undefined : effort;
  const contentId = useId();
  const descriptionId = useId();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!closeHandle) return;
    closeHandle.current = close;
    return () => {
      closeHandle.current = null;
    };
  }, [closeHandle, close]);
  const trigger = useRef<HTMLButtonElement>(null);
  const [summaries, setSummaries] = useState<
    Record<string, { label: string; safety?: string; changed?: boolean }>
  >({});
  const publish = useCallback(
    (
      id: string,
      label: string | undefined,
      safety?: string,
      changed?: boolean,
    ) => {
      setSummaries((current) => {
        if (
          current[id]?.label === label &&
          current[id]?.safety === safety &&
          current[id]?.changed === changed
        )
          return current;
        const next = { ...current };
        if (label === undefined) delete next[id];
        else next[id] = { label, safety, changed };
        return next;
      });
    },
    [],
  );
  const choices = Object.values(summaries);
  const details = choices
    .filter(
      ({ label }) =>
        /^(Approval|Permissions|Session mode):/.test(label) ||
        /^Approval mode:/.test(label),
    )
    .map(({ label }) =>
      label
        .replace(/^[^:]+:\s*/, '')
        .split(/[.—]/)[0]
        .trim(),
    );
  const safety = [
    ...new Set(
      choices.flatMap(({ safety }) => (safety ? safety.split('; ') : [])),
    ),
  ];
  const changed = choices.some((choice) => choice.changed);
  const summary = [
    ...new Set([
      shownEffort ? `${label} · ${shownEffort}` : label,
      ...details,
      ...safety,
      ...(changed ? ['changed for this conversation'] : []),
      ...(notice ? [notice] : []),
    ]),
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
          caption={null}
          value={
            separator < 0 ? (
              label
            ) : (
              <span className="composer-run-control__label">
                {/* The Agent's own mark names it; the scarce text goes to the
                    Model. The accessible name keeps the full label. */}
                {!icon && (
                  <span className="composer-run-control__agent">
                    {label.slice(0, separator)}
                    {' · '}
                  </span>
                )}
                <span className="composer-run-control__model">
                  {label.slice(separator + 3)}
                </span>
                {shownEffort && (
                  <span className="composer-run-control__effort">
                    {' · '}
                    {shownEffort}
                  </span>
                )}
              </span>
            )
          }
          icon={
            <span className="composer-run-control__marks">
              <span className="composer-run-control__agent-mark">{mark}</span>
              {engineId &&
                hasBundledEngineMark(engineId) &&
                agentBrand !== engineBrand && (
                  <span className="composer-run-control__engine-mark">
                    <BrandIcon name="" engineId={engineId} size={16} />
                  </span>
                )}
              {changed && <span aria-hidden="true">·</span>}
              {safety.length > 0 && (
                <span
                  className="composer-run-control__safety"
                  aria-hidden="true"
                >
                  ⚠
                </span>
              )}
            </span>
          }
          notice={
            notice && (
              <span className="composer-run-control__notice" aria-hidden="true">
                {/* The separator collapses with the label it follows. */}
                <span className="composer-run-control__notice-separator">
                  {'· '}
                </span>
                {notice}
              </span>
            )
          }
          title={description ? `${summary}. ${description}` : summary}
          aria-label={summary}
          aria-describedby={description ? descriptionId : undefined}
          data-testid="run-setup-trigger"
          aria-haspopup="dialog"
          aria-controls={contentId}
          aria-expanded={open}
          onClick={() => setOpen(true)}
        />
      )}
      {description && (
        <span id={descriptionId} hidden>
          {description}
        </span>
      )}
      <ResponsiveDialogSurface
        open={open}
        layer="popover"
        // A picker opened from a choice here replaces this panel rather than
        // stacking on it.
        yieldToChildPopover
        ariaLabel="Agent & model"
        onClose={() => setOpen(false)}
        anchorRef={trigger}
        returnFocusTarget={trigger.current}
        overlayClassName="composer-popover-overlay composer-popover-overlay--start"
        panelClassName="composer-popover-panel composer-run-panel"
      >
        <ResponsiveDialogHeader
          title="Agent & model"
          closeLabel="Close settings"
          onClose={() => setOpen(false)}
        />
        <ComposerChoiceSummary.Provider value={publish}>
          <ComposerRunSetupClose.Provider value={close}>
            <div id={contentId} className="composer-run-panel__choices">
              {children}
            </div>
          </ComposerRunSetupClose.Provider>
        </ComposerChoiceSummary.Provider>
      </ResponsiveDialogSurface>
    </>
  );
}
