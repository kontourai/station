import {
  type EngineId,
  parseEngineId,
} from '@kontourai/station-contracts/agent-identity';
import {
  cloneElement,
  isValidElement,
  type ReactNode,
  useCallback,
  useId,
  useRef,
  useState,
} from 'react';
import { ComposerChoice } from './ComposerChoice';
import { ComposerChoiceSummary } from './ComposerChoiceSummary';
import { AgentIcon } from './icons/AgentIcon';
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
  icon,
  engineId,
  children,
  loadingLabel,
}: {
  label: string;
  icon: ReactNode;
  engineId?: EngineId | null;
  children: ReactNode;
  loadingLabel?: string;
}) {
  const agent =
    isValidElement<React.ComponentProps<typeof AgentIcon>>(icon) &&
    icon.type === AgentIcon
      ? icon.props.agent
      : undefined;
  const agentEngine =
    agent && (agent.engineId ?? parseEngineId(agent.slug ?? agent.id));
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
  const contentId = useId();
  const [open, setOpen] = useState(false);
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
      label,
      ...details,
      ...safety,
      ...(changed ? ['changed for this conversation'] : []),
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
                <span className="composer-run-control__agent">
                  {label.slice(0, separator)}
                </span>
                <span className="composer-run-control__model">
                  {' '}
                  · {label.slice(separator + 3)}
                </span>
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
          title={summary}
          aria-label={summary}
          data-testid="run-setup-trigger"
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
