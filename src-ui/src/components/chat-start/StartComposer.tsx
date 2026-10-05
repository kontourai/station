import { type ReactNode, type RefObject, useLayoutEffect, useRef } from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
import { ActionOverflowMenu, type OverflowAction } from '../ActionOverflowMenu';
import { Button } from '../Button';
import { AgentIcon } from '../icons/AgentIcon';
import { ArrowDownGlyph, CloseGlyph, GlobeGlyph } from '../icons/Glyph';
import { Skeleton } from '../state';
import './StartComposer.css';

/**
 * The Agent chip. `loading` until the start path can say which Agent and
 * Model it will use; a chip never shows a guess (label vs derivation).
 */
export type StartAgentChip =
  | { status: 'loading' }
  | {
      status: 'ready';
      /** Absent when this context has no Agent to offer. */
      agent?: AgentData;
      /**
       * The resolver's Model label. The resolver's "no model" literal is a
       * gap, not a Model: the chip then names the Agent alone.
       */
      modelLabel?: string;
      /** The Agent shown needs setup before Start can use it. */
      needsSetup: boolean;
    };

/** The project chip: the context the start runs in. */
export type StartProjectChip =
  | { status: 'loading' }
  | {
      status: 'ready';
      label: string;
      /** The project's accent (the sidebar's), absent for No project. */
      accent?: string;
      isGlobal: boolean;
      /** The folder the chat runs in, as the project menu also states. */
      folder?: string;
    };

export interface StartContextItem {
  id: string;
  label: string;
  detail: string;
  selected: boolean;
}

/** What `modelIdentityLabel` returns for no model id: never shown. */
const MODEL_NOT_REPORTED = 'Model not reported';

/** Visible text of the Agent chip: "Agent · Model". */
function startAgentChipText(chip: StartAgentChip): string {
  if (chip.status === 'loading') return '';
  if (!chip.agent) return 'Choose an agent';
  return chip.modelLabel && chip.modelLabel !== MODEL_NOT_REPORTED
    ? `${chip.agent.name} · ${chip.modelLabel}`
    : chip.agent.name;
}

/** The compact text box grows with its text up to this many lines. */
const COMPACT_MAX_LINES = 5;

function clearFittedSize(element: HTMLTextAreaElement) {
  element.style.removeProperty('height');
  element.style.removeProperty('overflow-y');
}

/**
 * Size a compact text box to its content, up to `COMPACT_MAX_LINES`, then
 * scroll. Done here rather than with `field-sizing: content`, which the
 * desktop app's WebKit does not support. The 44px floor is CSS min-height.
 */
function fitCompactTextarea(element: HTMLTextAreaElement) {
  element.style.height = 'auto';
  const content = element.scrollHeight;
  // Not laid out (hidden, or no layout engine): leave the CSS size alone.
  if (!content) {
    clearFittedSize(element);
    return;
  }
  const style = getComputedStyle(element);
  const px = (value: string) => Number.parseFloat(value) || 0;
  const lineHeight = px(style.lineHeight) || px(style.fontSize) * 1.2 || 20;
  const padding = px(style.paddingTop) + px(style.paddingBottom);
  const border = px(style.borderTopWidth) + px(style.borderBottomWidth);
  // border-box: the height includes padding and border; scrollHeight has
  // the padding but not the border.
  const max = lineHeight * COMPACT_MAX_LINES + padding + border;
  const wanted = content + border;
  element.style.height = `${Math.min(wanted, max)}px`;
  element.style.overflowY = wanted > max ? 'auto' : 'hidden';
}

/**
 * The one way to start a chat (Home, inline, and the dock's draft): a text
 * box, an Agent chip, a project chip, an overflow for the rarer options, and
 * Start. Both surfaces render this component over `useStartSelection`, so the
 * chips mean the same thing and remember the same way on each; what differs
 * is only what Start hands the dock (`HomeStartComposer`) or starts in place
 * (`NewChatModal`).
 *
 * The chips sit in their own group, apart from Start (the button cap): a
 * chip is a choice, Start is the one action.
 */
export function StartComposer({
  prompt,
  onPromptChange,
  textareaRef,
  compact = false,
  agent,
  onOpenAgents,
  project,
  onOpenProject,
  overflowActions,
  skill,
  contextItems,
  onToggleContextItem,
  canStart,
  pending,
  onStart,
  note,
  children,
}: {
  prompt: string;
  onPromptChange: (value: string) => void;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /** One line, above a page of work (Home with work). */
  compact?: boolean;
  agent: StartAgentChip;
  onOpenAgents: (trigger: HTMLElement) => void;
  project: StartProjectChip;
  onOpenProject: (trigger: HTMLElement) => void;
  overflowActions?: readonly OverflowAction[];
  /** A chosen visual skill, removable. */
  skill?: { title: string; onRemove: () => void };
  /** Context handed to this draft, each removable before Start. */
  contextItems?: StartContextItem[];
  onToggleContextItem?: (id: string) => void;
  canStart: boolean;
  pending: boolean;
  onStart: () => void;
  /** One quiet line under the bar: what Start will do when it is unusual. */
  note?: string;
  /** Feedback and setup that belong to this draft. */
  children?: ReactNode;
}) {
  const ownTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fieldRef = textareaRef ?? ownTextareaRef;
  // Typed, restored or cleared: the compact box fits what it now holds.
  // biome-ignore lint/correctness/useExhaustiveDependencies: prompt is the trigger; the element is read from the ref.
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    if (compact) fitCompactTextarea(field);
    // Home flips one instance between compact and full as work comes and
    // goes; the full composer sizes from CSS, so drop what compact set.
    else clearFittedSize(field);
  }, [compact, prompt]);
  const agentText = startAgentChipText(agent);
  return (
    <form
      className={`start-composer${compact ? ' start-composer--compact' : ''}`}
      aria-label="Start work"
      onSubmit={(event) => {
        event.preventDefault();
        if (canStart && !pending) onStart();
      }}
    >
      {contextItems && contextItems.length > 0 && (
        <fieldset
          className="start-composer__context"
          aria-label="Context for this chat"
        >
          {contextItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className="start-composer__context-chip"
              aria-pressed={item.selected}
              aria-label={`${item.label}: ${item.detail}`}
              title={item.detail}
              onClick={() => onToggleContextItem?.(item.id)}
            >
              <span className="start-composer__context-label">
                {item.label}
              </span>
              <span className="start-composer__context-detail">
                {item.detail}
              </span>
            </button>
          ))}
        </fieldset>
      )}
      <textarea
        ref={fieldRef}
        className="editor-textarea start-composer__input"
        aria-label="What would you like done?"
        placeholder="Tell Station what you want done…"
        rows={compact ? 1 : 3}
        value={prompt}
        onChange={(event) => onPromptChange(event.target.value)}
      />
      <div className="start-composer__bar">
        <fieldset className="start-composer__chips" aria-label="Chat setup">
          {agent.status === 'loading' ? (
            <span
              className="start-composer__chip start-composer__chip--loading"
              role="status"
              aria-label="Checking which Agent will start"
            >
              <Skeleton variant="line" width="9rem" />
            </span>
          ) : (
            <button
              type="button"
              className={`choice-trigger start-composer__chip start-composer__chip--agent${agent.needsSetup ? ' start-composer__chip--attention' : ''}`}
              aria-haspopup="dialog"
              aria-label={`Agent: ${agentText}${agent.needsSetup ? ', needs setup' : ''}`}
              onClick={(event) => onOpenAgents(event.currentTarget)}
            >
              {agent.agent && <AgentIcon agent={agent.agent} size="small" />}
              <span className="start-composer__chip-text">{agentText}</span>
              <ArrowDownGlyph className="choice-caret" />
            </button>
          )}
          {project.status === 'loading' ? (
            <span
              className="start-composer__chip start-composer__chip--loading"
              role="status"
              aria-label="Checking which project the chat starts in"
            >
              <Skeleton variant="line" width="6rem" />
            </span>
          ) : (
            <button
              type="button"
              className="choice-trigger start-composer__chip start-composer__chip--project"
              aria-haspopup="dialog"
              aria-label={`Project: ${project.label}`}
              title={project.folder}
              onClick={(event) => onOpenProject(event.currentTarget)}
            >
              {/* TODO(project-icons): adopt `ProjectIcon` (with its accent
                  fallback) once feat/project-icons lands. Until then the
                  sidebar's accent swatch, never a raw `project.icon`:
                  LayoutIcon would hotlink a remote or path icon. */}
              {project.isGlobal ? (
                <GlobeGlyph />
              ) : (
                <span
                  className="start-composer__swatch"
                  aria-hidden="true"
                  style={{ backgroundColor: project.accent }}
                />
              )}
              <span className="start-composer__chip-text">{project.label}</span>
              <ArrowDownGlyph className="choice-caret" />
            </button>
          )}
          {skill && (
            <span className="start-composer__chip start-composer__chip--skill">
              <span className="start-composer__chip-text">{skill.title}</span>
              <button
                type="button"
                className="start-composer__chip-remove"
                aria-label={`Remove visual skill ${skill.title}`}
                onClick={skill.onRemove}
              >
                <CloseGlyph />
              </button>
            </span>
          )}
        </fieldset>
        {/* The rarer options sit with Start, apart from the chips: on a
            phone the chips keep row one and this pair takes row two. */}
        <div className="start-composer__actions">
          {overflowActions && overflowActions.length > 0 && (
            <ActionOverflowMenu
              label="More start options"
              actions={overflowActions}
              triggerClassName="action-overflow__trigger start-composer__more"
            />
          )}
          <Button
            type="submit"
            variant="primary"
            className="start-composer__start"
            disabled={!canStart}
            pending={pending}
            pendingLabel="Starting…"
          >
            Start
          </Button>
        </div>
      </div>
      {note && <p className="start-composer__note">{note}</p>}
      {children}
    </form>
  );
}
