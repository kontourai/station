import type { ReactNode } from 'react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { copyToClipboard } from '../../lib/clipboard';
import type { ChatMessage } from '../../types';
import {
  deriveLatestPlanArtifactFromMessages,
  type PlanArtifact,
} from '../../utils/planArtifacts';
import { LazyMarkdown } from '../chat/LazyMarkdown';
import { Empty } from '../state';

export type WorkflowPlanStepStatus = 'completed' | 'in_progress' | 'pending';

export interface WorkflowPlanStep {
  id: string;
  label: string;
  status: WorkflowPlanStepStatus;
}

export interface WorkflowPlanArtifact {
  title: string;
  markdown: string;
  rawText: string;
  steps: WorkflowPlanStep[];
  updatedAt?: number;
}

const MARKDOWN_STEP_PATTERN = /^\s*(?:[-*]|\d+\.)\s+\[(x|X| |>)\]\s+(.+)$/;
const MARKDOWN_TITLE_PATTERN = /^#{1,6}\s+(.+)$/m;

// Inline-only markdown for single-line step labels (Steps view). Full
// ReactMarkdown (used for the Markdown tab and chat messages) renders
// block-level elements like `<p>`/`<ul>`, which don't nest safely inside the
// step row's `<span>`. Step labels only ever need bold/italic/code/link
// spans, so a small tokenizer covers the real cases cheaply without pulling
// block parsing (or a new dependency) into a single-line label.
type InlineMarkdownToken =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'link'; value: string; href: string };

export function parseInlineMarkdown(text: string): InlineMarkdownToken[] {
  const tokens: InlineMarkdownToken[] = [];
  let plainStart = 0;
  let index = 0;
  const pushPlain = (end: number) => {
    if (end > plainStart)
      tokens.push({ type: 'text', value: text.slice(plainStart, end) });
  };

  // Link punctuation is located with two MONOTONIC scan pointers that never
  // move backward. Every link lookup starts at a non-decreasing offset
  // (`index` only advances), so each pointer advances through the string at
  // most once overall; a pointer parked on a found `]`/`)` may be re-read by a
  // few later candidates, but each such re-read is O(1). With at most N lookups
  // that makes the parser strictly O(n) on every input — including hostile
  // shapes (`[`×N, `[x](`×N with no `)`, or `[`×N + text + a single far `]`).
  // There is no length cap and no silent content drop: non-link text still
  // renders, with its other inline markdown intact.
  let closeBracketPtr = 0;
  let parenPtr = 0;
  const nextCloseBracket = (from: number): number => {
    if (closeBracketPtr < from) closeBracketPtr = from;
    while (closeBracketPtr < text.length && text[closeBracketPtr] !== ']')
      closeBracketPtr += 1;
    return closeBracketPtr < text.length ? closeBracketPtr : -1;
  };
  const nextParen = (from: number): number => {
    if (parenPtr < from) parenPtr = from;
    while (parenPtr < text.length && text[parenPtr] !== ')') parenPtr += 1;
    return parenPtr < text.length ? parenPtr : -1;
  };

  while (index < text.length) {
    const marker = text[index]!;
    if (marker === '[') {
      // `[label](href)`. The label closes at the FIRST `]` (a lightweight,
      // non-CommonMark inline parser — enough for one-line step labels, and
      // it keeps `[a] [b](c)` parsing as text + a `[b](c)` link rather than a
      // greedy `a] [b` label). A nested-bracket label like `[a [b]](url)` is
      // deliberately left as plain text — supporting balanced nesting is out of
      // scope for this small step-label parser, not linkifying it is safe.
      // Both scans use the monotonic pointers, so this stays O(n) on hostile
      // input.
      const labelEnd = nextCloseBracket(index + 1);
      if (labelEnd !== -1 && text[labelEnd + 1] === '(') {
        const hrefEnd = nextParen(labelEnd + 2);
        // Require a non-empty destination; `[label]` stays plain text.
        if (hrefEnd !== -1 && hrefEnd > labelEnd + 2) {
          pushPlain(index);
          tokens.push({
            type: 'link',
            value: text.slice(index + 1, labelEnd),
            href: text.slice(labelEnd + 2, hrefEnd),
          });
          index = hrefEnd + 1;
          plainStart = index;
          continue;
        }
      }
    }

    const delimiter =
      marker === '`'
        ? '`'
        : text.startsWith('**', index)
          ? '**'
          : text.startsWith('__', index)
            ? '__'
            : marker === '*'
              ? '*'
              : marker === '_'
                ? '_'
                : undefined;
    if (delimiter) {
      const contentStart = index + delimiter.length;
      const end = text.indexOf(delimiter, contentStart);
      if (end !== -1 && end > contentStart) {
        pushPlain(index);
        const value = text.slice(contentStart, end);
        tokens.push({
          type:
            delimiter === '`'
              ? 'code'
              : delimiter.length === 2
                ? 'bold'
                : 'italic',
          value,
        });
        index = end + delimiter.length;
        plainStart = index;
        continue;
      }
    }
    index += 1;
  }
  pushPlain(text.length);
  return tokens;
}

export function renderInlineMarkdown(text: string): ReactNode {
  return parseInlineMarkdown(text).map((token, index) => {
    switch (token.type) {
      case 'code':
        return <code key={index}>{token.value}</code>;
      case 'bold':
        return <strong key={index}>{token.value}</strong>;
      case 'italic':
        return <em key={index}>{token.value}</em>;
      case 'link': {
        // Step text is agent-authored: only allow benign link schemes so a
        // crafted [text](javascript:...) never becomes an executable href.
        const safeHref = /^(https?:|mailto:|\/|#)/i.test(token.href ?? '')
          ? token.href
          : undefined;
        if (!safeHref) return <Fragment key={index}>{token.value}</Fragment>;
        return (
          <a
            key={index}
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
          >
            {token.value}
          </a>
        );
      }
      default:
        return <Fragment key={index}>{token.value}</Fragment>;
    }
  });
}

function slugifyTitle(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'workflow-plan'
  );
}

function stepCheckbox(status: WorkflowPlanStepStatus) {
  if (status === 'completed') return 'x';
  if (status === 'in_progress') return '>';
  return ' ';
}

function stepStatusLabel(status: WorkflowPlanStepStatus) {
  if (status === 'completed') return 'Completed';
  if (status === 'in_progress') return 'Active';
  return 'Pending';
}

function buildMarkdown(title: string, steps: WorkflowPlanStep[]) {
  if (steps.length === 0) {
    return `# ${title}`;
  }

  const checklist = steps
    .map((step) => `- [${stepCheckbox(step.status)}] ${step.label}`)
    .join('\n');

  return `# ${title}\n\n${checklist}`;
}

function extractTitle(content: string) {
  const heading = content.match(MARKDOWN_TITLE_PATTERN)?.[1]?.trim();
  if (heading) {
    return heading;
  }

  const planLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /plan/i.test(line));

  return planLine || 'Workflow plan';
}

export function deriveWorkflowPlanArtifact(
  messages: ChatMessage[],
): WorkflowPlanArtifact | null {
  return toWorkflowPlanArtifact(
    deriveLatestPlanArtifactFromMessages(messages as any),
  );
}

export function toWorkflowPlanArtifact(
  artifact: PlanArtifact | null | undefined,
): WorkflowPlanArtifact | null {
  if (!artifact) {
    return null;
  }

  const title = extractTitle(artifact.rawText);
  const steps = artifact.steps.map((step, index) => ({
    id: `plan-step-${index}`,
    label: step.content,
    status: step.status,
  }));
  const markdown =
    /^#{1,6}\s+/m.test(artifact.rawText) ||
    MARKDOWN_STEP_PATTERN.test(artifact.rawText)
      ? artifact.rawText
      : buildMarkdown(title, steps);

  return {
    title,
    markdown,
    rawText: artifact.rawText,
    steps,
    updatedAt: artifact.updatedAt ? Date.parse(artifact.updatedAt) : undefined,
  };
}

function downloadFile(filename: string, mimeType: string, contents: string) {
  const blob = new Blob([contents], { type: mimeType });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

function StepStatusBadge({ status }: { status: WorkflowPlanStepStatus }) {
  return (
    <span
      className={`workflow-plan-panel__step-badge workflow-plan-panel__step-badge--${status}`}
    >
      {stepStatusLabel(status)}
    </span>
  );
}

export type WorkflowPlanRuntimeState = {
  status?: string | null;
  pendingApprovals?: number;
  isProcessingStep?: boolean;
};

export type WorkflowPlanRuntimeStrip = {
  label: string;
  tone: 'live' | 'attention' | 'complete';
  live: boolean;
};

/**
 * Pure {label,tone,live} derivation for the runtime-state strip. Richest
 * signal first: pending approvals outrank in-flight tool activity, which
 * outranks the coarser session `status`, mirroring
 * `deriveActivityLabel`'s richest-signal-first convention
 * (StreamingMessage.tsx) for the analogous per-message activity hint.
 */
export function deriveWorkflowRuntimeStrip(
  runtimeState?: WorkflowPlanRuntimeState,
): WorkflowPlanRuntimeStrip | null {
  if ((runtimeState?.pendingApprovals || 0) > 0) {
    return {
      label: `Approval required (${runtimeState?.pendingApprovals})`,
      tone: 'attention',
      live: true,
    };
  }
  if (runtimeState?.isProcessingStep) {
    return { label: 'Tool activity running', tone: 'live', live: true };
  }
  if (runtimeState?.status === 'awaiting-approval') {
    return { label: 'Awaiting approval', tone: 'attention', live: true };
  }
  if (
    runtimeState?.status === 'running' ||
    runtimeState?.status === 'sending'
  ) {
    return { label: 'Engine running', tone: 'live', live: true };
  }
  if (
    runtimeState?.status === 'completed' ||
    runtimeState?.status === 'exited'
  ) {
    return { label: 'Engine complete', tone: 'complete', live: false };
  }
  return null;
}

export function WorkflowPlanPanel({
  artifact,
  sessionTitle,
  runtimeState,
}: {
  artifact: WorkflowPlanArtifact | null;
  sessionTitle?: string | null;
  runtimeState?: WorkflowPlanRuntimeState;
}) {
  const [activeView, setActiveView] = useState<'steps' | 'markdown'>('steps');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );

  useEffect(() => {
    if (copyState === 'idle') return;
    const timeout = window.setTimeout(() => setCopyState('idle'), 1500);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const markdownFilename = useMemo(() => {
    const title = artifact?.title || 'workflow-plan';
    return `${slugifyTitle(title)}.md`;
  }, [artifact?.title]);

  const exportFilename = useMemo(() => {
    const title = artifact?.title || 'workflow-plan';
    return `${slugifyTitle(title)}.json`;
  }, [artifact?.title]);

  const hasSteps = (artifact?.steps.length || 0) > 0;
  const summary = useMemo(() => {
    const steps = artifact?.steps || [];
    return {
      completed: steps.filter((step) => step.status === 'completed').length,
      active: steps.filter((step) => step.status === 'in_progress').length,
      pending: steps.filter((step) => step.status === 'pending').length,
    };
  }, [artifact]);

  const runtime = useMemo(
    () => deriveWorkflowRuntimeStrip(runtimeState),
    [runtimeState],
  );

  const handleCopy = async () => {
    if (!artifact?.markdown) return;
    setCopyState(
      (await copyToClipboard(artifact.markdown)) ? 'copied' : 'failed',
    );
  };

  const handleSave = () => {
    if (!artifact?.markdown) return;
    downloadFile(markdownFilename, 'text/markdown', artifact.markdown);
  };

  const handleExport = () => {
    if (!artifact) return;
    downloadFile(
      exportFilename,
      'application/json',
      JSON.stringify(
        {
          title: artifact.title,
          markdown: artifact.markdown,
          steps: artifact.steps,
          updatedAt: artifact.updatedAt ?? null,
        },
        null,
        2,
      ),
    );
  };

  return (
    <aside className="workflow-plan-panel">
      <div className="workflow-plan-panel__header">
        <div>
          <p className="workflow-plan-panel__eyebrow">Workflow plan</p>
          <h2 className="workflow-plan-panel__title">
            {artifact?.title || 'No plan captured yet'}
          </h2>
          <p className="workflow-plan-panel__subtitle">
            {sessionTitle
              ? `Linked to ${sessionTitle}`
              : 'Plan artifacts appear here as the active coding chat updates.'}
          </p>
        </div>
        <div className="workflow-plan-panel__actions">
          <button
            type="button"
            className={`workflow-plan-panel__action${
              copyState === 'failed' ? ' copy-affordance--failed' : ''
            }`}
            title={
              copyState === 'failed'
                ? 'This browser refused clipboard access — use Save to write the plan to a file instead.'
                : undefined
            }
            onClick={() => {
              void handleCopy();
            }}
            disabled={!artifact}
          >
            {copyState === 'copied'
              ? 'Copied'
              : copyState === 'failed'
                ? "Can't copy"
                : 'Copy'}
          </button>
          <button
            type="button"
            className="workflow-plan-panel__action"
            onClick={handleSave}
            disabled={!artifact}
          >
            Save
          </button>
          <button
            type="button"
            className="workflow-plan-panel__action"
            onClick={handleExport}
            disabled={!artifact}
          >
            Export
          </button>
        </div>
      </div>

      {artifact ? (
        <>
          {runtime && (
            <div
              className={`workflow-plan-panel__runtime-state workflow-plan-panel__runtime-state--${runtime.tone}`}
            >
              <span
                className={`workflow-plan-panel__runtime-dot${
                  runtime.live ? ' workflow-plan-panel__runtime-dot--live' : ''
                }`}
                aria-hidden="true"
              />
              <span>{runtime.label}</span>
            </div>
          )}
          <div className="workflow-plan-panel__summary">
            <div>
              <span className="workflow-plan-panel__summary-value">
                {summary.active}
              </span>
              <span className="workflow-plan-panel__summary-label">active</span>
            </div>
            <div>
              <span className="workflow-plan-panel__summary-value">
                {summary.completed}
              </span>
              <span className="workflow-plan-panel__summary-label">done</span>
            </div>
            <div>
              <span className="workflow-plan-panel__summary-value">
                {summary.pending}
              </span>
              <span className="workflow-plan-panel__summary-label">queued</span>
            </div>
          </div>

          <div className="workflow-plan-panel__view-switcher" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeView === 'steps'}
              className={`workflow-plan-panel__view-tab${activeView === 'steps' ? ' is-active' : ''}`}
              onClick={() => setActiveView('steps')}
            >
              Steps
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeView === 'markdown'}
              className={`workflow-plan-panel__view-tab${activeView === 'markdown' ? ' is-active' : ''}`}
              onClick={() => setActiveView('markdown')}
            >
              Markdown
            </button>
          </div>

          <div className="workflow-plan-panel__body">
            {activeView === 'steps' ? (
              hasSteps ? (
                <ol className="workflow-plan-panel__steps">
                  {artifact.steps.map((step) => (
                    <li
                      key={step.id}
                      className={`workflow-plan-panel__step workflow-plan-panel__step--${step.status}`}
                    >
                      <div className="workflow-plan-panel__step-row">
                        <StepStatusBadge status={step.status} />
                        <span className="workflow-plan-panel__step-label">
                          {renderInlineMarkdown(step.label)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <Empty
                  variant="compact"
                  label="This plan does not expose structured steps yet."
                  description="Open the markdown view for the full artifact."
                />
              )
            ) : (
              <div className="workflow-plan-panel__markdown markdown-body">
                <LazyMarkdown>{artifact.markdown}</LazyMarkdown>
              </div>
            )}
          </div>
        </>
      ) : (
        <Empty
          variant="prominent"
          label="No plan artifact is available for this project yet."
          description="Start or resume a coding chat with planning updates to populate the panel."
        />
      )}
    </aside>
  );
}
