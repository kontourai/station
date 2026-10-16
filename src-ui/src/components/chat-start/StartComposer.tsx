import type { STTState } from '@kontourai/station-sdk';
import { type ReactNode, type RefObject, useLayoutEffect, useRef } from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
import { useFileAttachment } from '../../hooks/useFileAttachment';
import { useDockSlotDevice } from '../../hooks/useIsMobile';
import { filesFromDataTransfer } from '../../utils/attachment-file-transfer';
import { MODEL_NOT_REPORTED } from '../../utils/modelCapabilities';
import { ActionOverflowMenu, type OverflowAction } from '../ActionOverflowMenu';
import { Button } from '../Button';
import { AgentIcon } from '../icons/AgentIcon';
import { ArrowDownGlyph, CloseGlyph } from '../icons/Glyph';
import { displayableProjectIcon, ProjectIcon } from '../icons/ProjectIcon';
import { Skeleton } from '../state';
import { VoiceOrb } from '../voice/VoiceOrb';
import { StartApprovalSummary } from './StartApprovalSummary';
import './StartComposer.css';

/**
 * Files for the new chat's first message. They are handed to the chat Start
 * opens, which stages them under the engine and Model it runs (the same
 * intake, limits and image check as a reply), so nothing here guesses what
 * that engine accepts.
 */
export interface StartComposerFiles {
  list: readonly File[];
  onAdd: (files: File[]) => void;
  onRemove: (index: number) => void;
}

/** Dictation into the prompt; the same control the chat composer offers. */
export interface StartComposerVoice {
  state: STTState;
  supported: boolean;
  unsupportedReason?: string;
  error?: string;
  onStart: () => void;
  onStop: () => void;
}

// The chat composer's picker list (FileAttachmentInput): images, including
// HEIF some pickers do not class as image/*, and the document types.
const START_FILE_ACCEPT = 'image/*,.heic,.heif,.pdf,.txt,.csv,.md,.json';

function StartAttachButton({ onAdd }: { onAdd: (files: File[]) => void }) {
  const { fileInputRef, attachButtonRef, handleFileSelect, openFilePicker } =
    useFileAttachment({ onFilesSelected: onAdd });
  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={START_FILE_ACCEPT}
        onChange={handleFileSelect}
        className="attachment-input"
        tabIndex={-1}
        aria-hidden="true"
      />
      <button
        type="button"
        ref={attachButtonRef}
        className="start-composer__tool"
        aria-label="Attach files"
        title="Attach files"
        onClick={openFilePicker}
      >
        <svg
          aria-hidden="true"
          focusable="false"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </button>
    </>
  );
}

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
      executionAgentId?: string;
      environmentId?: string;
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
      /** The project icon, when its stored value is displayable. */
      icon?: string;
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
  placeholder = 'Tell Station what you want done…',
  onPromptChange,
  textareaRef,
  compact = false,
  heading,
  agent,
  onOpenAgents,
  onOpenModel,
  project,
  onOpenProject,
  projectFixed = false,
  stationControl,
  overflowActions,
  skill,
  contextItems,
  onToggleContextItem,
  canStart,
  pending,
  onStart,
  note,
  files,
  voice,
  children,
}: {
  prompt: string;
  placeholder?: string;
  onPromptChange: (value: string) => void;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /** One line, above a page of work (Home with work). */
  compact?: boolean;
  heading?: string;
  agent: StartAgentChip;
  onOpenAgents: (trigger: HTMLElement) => void;
  onOpenModel?: (trigger: HTMLElement) => void;
  project: StartProjectChip;
  onOpenProject: (trigger: HTMLElement) => void;
  projectFixed?: boolean;
  stationControl?: ReactNode;
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
  /** Attach and paste files for the first message. */
  files?: StartComposerFiles;
  voice?: StartComposerVoice;
  /** Feedback and setup that belong to this draft. */
  children?: ReactNode;
}) {
  const { coarsePointer } = useDockSlotDevice();
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
  const agentText =
    onOpenModel && agent.status === 'ready'
      ? (agent.agent?.name ?? 'Choose an agent')
      : startAgentChipText(agent);
  return (
    <form
      className={`start-composer${compact ? ' start-composer--compact' : ''}`}
      data-coarse-pointer={coarsePointer || undefined}
      aria-label="Start work"
      onSubmit={(event) => {
        event.preventDefault();
        if (canStart && !pending) onStart();
      }}
    >
      <div className="start-composer__destination">
        <h2>
          {heading ?? (compact ? 'Start work' : 'What would you like to do?')}
        </h2>
        {project.status === 'ready' && (
          <button
            type="button"
            className="choice-trigger start-composer__project"
            aria-haspopup={projectFixed ? undefined : 'dialog'}
            aria-label={`Project: ${project.label}`}
            title={project.folder}
            disabled={projectFixed}
            onClick={(event) => onOpenProject(event.currentTarget)}
          >
            {!project.isGlobal && (
              <ProjectIcon
                project={{ name: project.label, icon: project.icon }}
                size={displayableProjectIcon(project.icon) ? 18 : 24}
                accent={project.accent}
              />
            )}
            <span>
              {project.isGlobal ? 'Without a project' : `in ${project.label}`}
            </span>
            {!projectFixed && <ArrowDownGlyph className="choice-caret" />}
          </button>
        )}
        {project.status === 'loading' && (
          <span
            role="status"
            aria-label="Checking which project the chat starts in"
          >
            <Skeleton variant="line" width="6rem" />
          </span>
        )}
        {stationControl}
      </div>
      <div className="start-composer__box">
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
          placeholder={placeholder}
          rows={compact ? 1 : 3}
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onPaste={(event) => {
            if (!files) return;
            const pasted = filesFromDataTransfer(event.clipboardData);
            if (pasted.length === 0) return;
            event.preventDefault();
            files.onAdd(pasted);
          }}
        />
        {files && files.list.length > 0 && (
          <ul
            className="start-composer__files"
            aria-label="Files for this chat"
          >
            {files.list.map((file, index) => (
              <li
                // Files have no identity of their own; position plus name
                // tells two same-named files apart.
                key={`${index}:${file.name}`}
                className="start-composer__file"
              >
                <span className="start-composer__file-name">{file.name}</span>
                <button
                  type="button"
                  className="start-composer__chip-remove"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => files.onRemove(index)}
                >
                  <CloseGlyph />
                </button>
              </li>
            ))}
          </ul>
        )}
        {voice?.state === 'error' && voice.error && (
          <p className="start-composer__alert" role="alert">
            {voice.error}
          </p>
        )}
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
                aria-label={`Agent: ${startAgentChipText(agent)}${agent.needsSetup ? ', needs setup' : ''}`}
                onClick={(event) => onOpenAgents(event.currentTarget)}
              >
                {agent.agent && <AgentIcon agent={agent.agent} size="small" />}
                <span className="start-composer__chip-text">{agentText}</span>
                <ArrowDownGlyph className="choice-caret" />
              </button>
            )}
            {onOpenModel && agent.status === 'ready' && (
              <button
                type="button"
                className="choice-trigger start-composer__chip start-composer__chip--model"
                aria-haspopup="dialog"
                aria-label={`Model: ${agent.modelLabel ?? MODEL_NOT_REPORTED}`}
                disabled={!agent.agent}
                onClick={(event) => onOpenModel(event.currentTarget)}
              >
                <span className="start-composer__chip-text">
                  {agent.modelLabel && agent.modelLabel !== MODEL_NOT_REPORTED
                    ? agent.modelLabel
                    : 'Model'}
                </span>
                <ArrowDownGlyph className="choice-caret" />
              </button>
            )}
            {agent.status === 'ready' &&
              (!agent.environmentId || agent.environmentId === 'current') &&
              agent.agent && (
                <StartApprovalSummary
                  agent={agent.agent}
                  executionAgentId={agent.executionAgentId}
                />
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
            <span className="start-composer__tools">
              {files && <StartAttachButton onAdd={files.onAdd} />}
              {voice && (
                <VoiceOrb
                  state={voice.state}
                  supported={voice.supported}
                  unsupportedReason={voice.unsupportedReason}
                  onStart={voice.onStart}
                  onStop={voice.onStop}
                />
              )}
              {overflowActions && overflowActions.length > 0 && (
                <ActionOverflowMenu
                  label="More start options"
                  actions={overflowActions}
                  triggerClassName="action-overflow__trigger start-composer__more"
                />
              )}
            </span>
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
      </div>
      {note && <p className="start-composer__note">{note}</p>}
      {children}
    </form>
  );
}
