import { Fragment } from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
import { useDevicePresentation } from '../../hooks/useDevicePresentation';
import {
  agentEngineDescriptor,
  type EngineDescriptor,
} from '../../utils/engine';
import { MODEL_NOT_REPORTED } from '../../utils/modelCapabilities';
import {
  type AgentFixRoute,
  AgentReadinessCell,
  agentFixLabel,
} from '../AgentReadinessCell';
import { agentRunnability } from '../agent-runnability';
import { engineChipLabel } from '../badges/EngineChip';
import { normalizedDisplayLabel } from '../chat/message-bubble/MessageAttribution';
import { AgentIcon } from '../icons/AgentIcon';
import { resolveNewChatAgentUnavailability } from '../modals/new-chat-modal-utils';
import { contextGlyph } from './ContextPickerOptions';
import './AgentPickerRow.css';

/**
 * The engine as the row's chip names it. An engine named after the Agent
 * plus a qualifier ("Claude Code (home-server proxy)" under "Claude Code")
 * keeps only the qualifier: the name is already the line above.
 */
function engineQualifiedBy(
  engine: EngineDescriptor | null,
  agentName: string,
): EngineDescriptor | null {
  if (!engine) return engine;
  // One trailing group only: under "Claude Code", "Claude Code (a) (b)" stays
  // whole rather than splitting into "a) (b".
  const match = /^(.+?)\s*\(([^()]+)\)$/.exec(engine.name);
  if (
    !match ||
    normalizedDisplayLabel(match[1]) !== normalizedDisplayLabel(agentName)
  )
    return engine;
  return { ...engine, name: match[2] };
}

/**
 * One Agent in a start picker: the New Chat list (fork) and the start
 * composer's Agent menu render this same row, so readiness, the model
 * trigger and the repair action read identically on both.
 */
function AgentPickerRow({
  agent,
  isSelected,
  selectedRef,
  onSelect,
  onHover,
  modelLabel,
  modelUnavailable,
  onOpenModel,
  interactionDisabled,
  fixLabel,
  fixDisabled,
  onFix,
}: {
  agent: AgentData;
  isSelected: boolean;
  selectedRef?: (element: HTMLButtonElement | null) => void;
  onSelect: () => void;
  onHover: () => void;
  modelLabel: string;
  modelUnavailable: boolean;
  /** Handed the trigger, so the picker returns focus to it on close. */
  onOpenModel: (trigger: HTMLElement) => void;
  interactionDisabled?: boolean;
  /** Set when this host knows Enable cannot be the repair — see the cell. */
  fixLabel?: 'Enable' | 'Connect' | 'Set up';
  fixDisabled?: boolean;
  onFix: (route: AgentFixRoute) => void;
}) {
  const unavailability = resolveNewChatAgentUnavailability(agent);
  // archive#3843: the picker and the Agents list mount the SAME cell, so they
  // must also read the same device projection — a row that named the host in
  // one surface and not the other would be the exact divergence §5 forbids.
  const devicePresentation = useDevicePresentation();
  const engine = agentEngineDescriptor(agent);
  const runnable = agentRunnability(agent).runnable;
  const chipEngine = engineQualifiedBy(engine, agent.name);
  const repeatsAgent =
    normalizedDisplayLabel(engineChipLabel(chipEngine)) ===
    normalizedDisplayLabel(agent.name);
  // What runs this Agent, as the quiet engine pill right after its name
  // rather than on a line of its own: that line doubled every such row's
  // height for one short label. A label that only repeats the name is the engine word
  // printed twice, so it is left out.
  const engineLabel =
    chipEngine && !repeatsAgent ? engineChipLabel(chipEngine) : undefined;
  // A model the engine never reported is not a model, so the row never
  // prints the gap (the Agent chip hides it too). With a catalog there is
  // still one to choose, so the trigger stays and asks for it; without one
  // there is nothing to show.
  const modelReported = modelLabel !== MODEL_NOT_REPORTED;
  // A row that cannot start keeps its trigger: a Model chosen before the
  // repair (Connect, Set up) is the intent the setup return carries back.
  const showModel = modelReported || !modelUnavailable;
  const modelText = modelReported ? modelLabel : 'Choose model';
  return (
    <div
      className="new-chat-modal__agent-row"
      // The full server sentence, on the ROW rather than the button: the row
      // button is disabled whenever there is a reason to show, and a disabled
      // button receives no hover in Chromium, so a title there would never
      // appear. Sighted parity for the sentence the row cannot show.
      title={unavailability?.description}
    >
      <button
        type="button"
        ref={selectedRef}
        data-agent-slug={agent.slug}
        className={`new-chat-modal__agent ${isSelected ? 'new-chat-modal__agent--selected' : ''}`}
        onMouseEnter={onHover}
        onClick={onSelect}
        disabled={interactionDisabled || !runnable}
        aria-describedby={
          unavailability ? `agent-${agent.slug}-unavailable` : undefined
        }
      >
        <div className="new-chat-modal__agent-header">
          <AgentIcon agent={agent} size="small" />
          <span
            className={`new-chat-modal__agent-name ${
              // archive#3027(d). A row that cannot start drops its NAME
              // a rung so absence reads as absence before the chip is read.
              // TO REVERT: delete this conditional class — the dimming lives
              // entirely in `.new-chat-modal__agent-name--dimmed`'s one
              // `color:` declaration.
              agent.available === false
                ? 'new-chat-modal__agent-name--dimmed'
                : ''
            }`.trim()}
          >
            {agent.name}
          </span>
          {/* What runs it, as the quiet engine pill, right after the name. */}
          {engineLabel && (
            <span className="new-chat-modal__agent-engine" title={engineLabel}>
              <span className="engine-chip__pill">{engineLabel}</span>
            </span>
          )}
          {/* A state only when nothing else on the row says it. "Ready" is
              what an enabled row says by being choosable, and a row that
              cannot start is already disabled, dimmed, and carries its one
              fixing button (Enable, Connect, Set up, Edit agent) at the end.
              Only a row with no fix of its own (a policy, or no fix kind at
              all) keeps the badge, so it is never a dead row with no reason.
              When shown it is the SHORT state (archive#4521), the Agents
              list's own word, never the server's paragraph, which stays on
              the row's title and assistive node. */}
          {!runnable && !agentFixLabel(agent) && (
            <AgentReadinessCell agent={agent} part="status" compact />
          )}
        </div>
        {!agent.engineDefault && agent.description && (
          <div
            className="new-chat-modal__agent-purpose"
            title={agent.description}
          >
            {agent.description}
          </div>
        )}
        {unavailability && (
          // Always rendered, always complete: the chip replaces the paragraph
          // VISUALLY, never in the accessibility tree. `--assistive` clips this
          // node to a screen-reader-only box so the aria-describedby target
          // still resolves to the whole sentence.
          // ALWAYS assistive: the row's visible statement is its dimmed name
          // and fix button (or, with no fix, the short state badge), and
          // painting the sentence too printed the same refusal twice.
          <div
            id={`agent-${agent.slug}-unavailable`}
            className="new-chat-modal__agent-reason new-chat-modal__agent-reason--assistive"
          >
            {unavailability.description}
          </div>
        )}
      </button>
      {/* State and action, together and right-aligned. The controls used to be
          bare siblings of a full-width button with no layout of their own, so
          every row wrapped them onto a second, left-aligned line under the
          name — the picker's dominant source of height. The row is a two-column
          grid now; neither the chip nor any action changed. */}
      <div className="new-chat-modal__agent-side">
        {showModel && (
          <button
            type="button"
            className="new-chat-modal__model-trigger"
            onClick={(event) => onOpenModel(event.currentTarget)}
            // An Agent whose engine has reported no catalog has no model to
            // choose — the trigger opened an empty picker. Disabled (not
            // hidden) while it still names a model, so the tooltip says why.
            disabled={interactionDisabled || modelUnavailable}
            aria-label={`Model: ${modelText}`}
            title={
              modelUnavailable
                ? 'This Agent has not reported a model catalog'
                : modelReported
                  ? `Choose model: ${modelLabel}`
                  : 'Choose model'
            }
          >
            {/* The model name alone. The `Model · ` prefix read four times per
              list and was the first thing the chip's own max-width ellipsized
              — on every seeded row the visible string ended at the model's
              actual name ("Model · Default (r…"), the one part that matters.
              What this control IS stays in the accessible name and tooltip. */}
            {modelText}
          </button>
        )}
        {/*
          DESIGN.md §5: the SAME readiness cell the Agents list row renders.
          The picker used to draw its own chip ("Not set up" behind a warning
          glyph, and nothing at all for a reason-kind refusal) beside its own
          remedy labels, over the same `agentRunnability` answer the list was
          badging differently one click away. One component, one wording, one
          verb — the row itself stays the Chat action, so no `onChat`.
*/}
        <AgentReadinessCell
          agent={agent}
          agentName={agent.name}
          devicePresentation={devicePresentation}
          fixLabel={fixLabel}
          fixDisabled={fixDisabled}
          className="button button--link"
          onFix={onFix}
          part="action"
        />
      </div>
    </div>
  );
}

interface AgentPickerGroup {
  label: string;
  icon?: string;
  glyph?: 'engine' | 'code' | 'globe' | 'plug' | 'time';
  agents: AgentData[];
}

/**
 * The grouped rows of a start picker. Both hosts own their own search,
 * loading and error states around it; this is only the list both share.
 */
export function AgentPickerGroups({
  groups,
  flatList,
  selectedIndex,
  selectedRef,
  onChoose,
  onHover,
  modelLabelFor,
  modelUnavailableFor,
  onOpenModel,
  interactionDisabled,
  fixDisabledFor,
  onFix,
}: {
  groups: AgentPickerGroup[];
  flatList: AgentData[];
  selectedIndex: number;
  selectedRef?: (element: HTMLButtonElement | null) => void;
  onChoose: (agent: AgentData) => void;
  onHover: (index: number) => void;
  modelLabelFor: (agent: AgentData) => string;
  modelUnavailableFor: (agent: AgentData) => boolean;
  onOpenModel: (agent: AgentData, trigger: HTMLElement) => void;
  interactionDisabled?: boolean;
  fixDisabledFor: (agent: AgentData) => boolean | undefined;
  onFix: (agent: AgentData, route: AgentFixRoute) => void;
}) {
  return (
    <>
      {groups.map((group, gi) => (
        <Fragment key={group.label}>
          <div
            className={`new-chat-modal__group-label ${group.glyph === 'plug' ? 'new-chat-modal__group-label--acp' : ''} ${
              // The rule between groups is a class so the header's hairline
              // is declared beside the row hairlines it has to line up with.
              gi > 0 ? 'new-chat-modal__group-label--divided' : ''
            }`.trim()}
          >
            {group.icon || contextGlyph(group.glyph)} {group.label}
          </div>
          {group.agents.map((agent) => {
            const idx = flatList.indexOf(agent);
            return (
              <AgentPickerRow
                key={agent.slug}
                agent={agent}
                isSelected={idx === selectedIndex}
                selectedRef={idx === selectedIndex ? selectedRef : undefined}
                onSelect={() => onChoose(agent)}
                onHover={() => onHover(idx)}
                modelLabel={modelLabelFor(agent)}
                modelUnavailable={modelUnavailableFor(agent)}
                onOpenModel={(trigger) => onOpenModel(agent, trigger)}
                interactionDisabled={interactionDisabled}
                fixDisabled={fixDisabledFor(agent)}
                onFix={(route) => onFix(agent, route)}
              />
            );
          })}
        </Fragment>
      ))}
    </>
  );
}
