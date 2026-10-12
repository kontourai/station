import { WORKSPACE_CODING_FILE_BROWSER_PANE_RENDERER_NAME } from '@kontourai/station-contracts/workspace-coding-panels';
import { parseWorkspaceOpenFilePreviewIntent } from '@kontourai/station-contracts/workspace-file-preview';
import {
  downloadProjectWorkspaceFilePreview,
  isRepositoryBusyError,
  isWorkspaceFilePreviewImageDataUrl,
  useProjectWorkspaceFileChangesQuery,
  useProjectWorkspaceFilePreviewQuery,
  WORKSPACE_FILE_PREVIEW_MAX_BYTES,
  type WorkspaceFilePreview,
  type WorkspaceFilePreviewLineRange,
  type WorkspaceFilePreviewPaneState,
  type WorkspaceFilePreviewStatus,
} from '@kontourai/station-sdk/workspace-file-preview';
import {
  createContext,
  type FormEvent,
  lazy,
  type KeyboardEvent as ReactKeyboardEvent,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { ActionOverflowMenu } from '../components/ActionOverflowMenu';
import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';
import { ImageInspector } from '../components/ImageInspector';
import { CheckGlyph, CopyGlyph } from '../components/icons/Glyph';
import { LazyBoundary } from '../components/LazyBoundary';
import { Empty, ErrorState, SkeletonBlock } from '../components/state';
import { useNavigation } from '../contexts/NavigationContext';
import { langFromFilePath } from '../highlight/langFromFilePath';
import type { PreviewTokenLine } from '../highlight/preview-tokens';
import { copyToClipboard } from '../lib/clipboard';
import {
  browserEpochMs,
  emitFilePreviewCommitPerformanceMark,
  emitFilePreviewScrollPerformanceMark,
  INTERACTIVE_WORKSPACE_FILE_PREVIEW_REFRESH_EVENT,
} from '../performance/interactive-workspace-performance-hooks';
import { useCodingFilesContext } from '../providers/context/CodingFilesContextProvider';
import {
  readFilePreviewPaneState,
  writeFilePreviewPaneState,
} from './filePreviewPaneStateStorage';
import {
  openFilePreviewDirectLink,
  serializeOpenFilePreviewIntent,
} from './openFilePreviewIntent';
import { PaneHeadSlotsContext, usePaneHeadSlots } from './PaneHeadSlots';
import { useResolvedWorkspacePaneCatalog } from './resolvedWorkspacePaneCatalog';
import { workspacePaneDirectRoute } from './workspacePaneDirectRoute';
import './FilePreviewPane.css';

const MAX_RENDERED_LINES = 2_000;
const GO_TO_LINE_SHORTCUT =
  typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform)
    ? '⌘G'
    : 'Ctrl+G';
const MAX_RENDERED_MARKDOWN_CHARACTERS = 64 * 1024;
const MAX_RENDERED_MARKDOWN_LINES = 1_000;
const MAX_RENDERED_MARKDOWN_SYNTAX_TOKENS = 4_096;
const MAX_RENDERED_MARKDOWN_NESTING = 64;
const MAX_RENDERED_MARKDOWN_DELIMITER_RUN = 128;
const MARKDOWN_LIST_MARKER = /(?:[-+*]|\d{1,9}[.)])(?=\s)/y;
const LazyInertRenderedMarkdown = lazy(() =>
  import('./InertRenderedMarkdown').then(({ InertRenderedMarkdown }) => ({
    default: InertRenderedMarkdown,
  })),
);
const MARKDOWN_SYNTAX_CHARACTERS = new Set([
  '#',
  '*',
  '_',
  '`',
  '[',
  ']',
  '(',
  ')',
  '|',
  '<',
  '>',
  '~',
  '-',
  '+',
  '!',
]);
/**
 * Coloured spans the pane will mount for one preview. Beyond it the whole
 * preview renders as plain text and says so; a partial colouring would read
 * as a grammar that stopped understanding the file.
 */
export const MAX_SOURCE_HIGHLIGHT_TOKENS = 40_000;

const STATUS_COPY: Record<
  Exclude<WorkspaceFilePreviewStatus, 'ready'>,
  string
> = {
  binary: 'This file is binary and cannot be shown as source or plain text.',
  oversized: 'This file is too large for the bounded preview.',
  unsupported: 'This file type is not supported by the initial preview.',
  missing: 'This file is no longer available in the Project workspace.',
  unreadable: 'Station could not read this file from the Project workspace.',
};

interface FilePreviewRefresh {
  projectSlug: string;
  path: string;
  nonce: string;
}

function ReferenceFilePreviewRefresh({
  projectSlug,
  path,
  refetch,
  completed,
}: {
  projectSlug: string;
  path: string;
  refetch(): Promise<{ isError: boolean }>;
  completed(refresh: FilePreviewRefresh): void;
}) {
  const [requested, setRequested] = useState<FilePreviewRefresh>();
  useLayoutEffect(() => {
    const refresh = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail;
      if (
        !detail ||
        typeof detail !== 'object' ||
        Array.isArray(detail) ||
        (detail as { projectSlug?: unknown }).projectSlug !== projectSlug ||
        (detail as { path?: unknown }).path !== path ||
        typeof (detail as { nonce?: unknown }).nonce !== 'string' ||
        !/^[A-Za-z0-9_-]{8,64}$/.test((detail as { nonce: string }).nonce)
      )
        return;
      const nonce = (detail as { nonce: string }).nonce;
      setRequested({ projectSlug, path, nonce });
    };
    window.addEventListener(
      INTERACTIVE_WORKSPACE_FILE_PREVIEW_REFRESH_EVENT,
      refresh,
    );
    return () =>
      window.removeEventListener(
        INTERACTIVE_WORKSPACE_FILE_PREVIEW_REFRESH_EVENT,
        refresh,
      );
  }, [path, projectSlug]);
  useEffect(() => {
    if (
      !requested ||
      requested.projectSlug !== projectSlug ||
      requested.path !== path
    )
      return;
    // Layout marks can arrive before subscription cleanup from the old pane.
    // Starting the read in this effect keeps that retired owner from cancelling it.
    let current = true;
    void refetch().then((result) => {
      if (!current) return;
      if (!result.isError) completed(requested);
      setRequested(undefined);
    });
    return () => {
      current = false;
    };
  }, [completed, path, projectSlug, refetch, requested]);
  return null;
}

export interface FilePreviewLineProjection {
  number: number;
  text: string;
  requested: boolean;
}

function sameRange(
  left: WorkspaceFilePreviewLineRange | undefined,
  right: WorkspaceFilePreviewLineRange | undefined,
): boolean {
  return left?.start === right?.start && left?.end === right?.end;
}

function latestMatchingFilePreviewState(
  stateKey: string,
  requestedState: WorkspaceFilePreviewPaneState,
): WorkspaceFilePreviewPaneState {
  const current = readFilePreviewPaneState(window.localStorage, stateKey);
  return current?.projectSlug === requestedState.projectSlug &&
    current.path === requestedState.path &&
    sameRange(current.lineRange, requestedState.lineRange)
    ? current
    : requestedState;
}

/** The response range owns numbering because ranged service content is sliced. */
function projectFilePreviewLines(
  preview: WorkspaceFilePreview,
  state: WorkspaceFilePreviewPaneState,
): readonly FilePreviewLineProjection[] {
  const content = (preview.content ?? '').slice(
    0,
    WORKSPACE_FILE_PREVIEW_MAX_BYTES,
  );
  const start = preview.lineRange?.start ?? 1;
  const visibleRange = preview.lineRange ?? state.lineRange;
  return content
    .split('\n')
    .slice(0, MAX_RENDERED_LINES)
    .map((text, index) => {
      const number = start + index;
      return {
        number,
        text,
        requested:
          !!visibleRange &&
          number >= visibleRange.start &&
          number <= visibleRange.end,
      };
    });
}

function lineId(stateKey: string, line: number): string {
  return `file-preview-${stateKey}-line-${line}`;
}

function PreviewStatus({ preview }: { preview: WorkspaceFilePreview }) {
  if (preview.status !== 'ready')
    return <p role="status">{STATUS_COPY[preview.status]}</p>;
  if (preview.renderKind === 'html' || preview.renderKind === 'pdf')
    return (
      <p role="status">
        This {preview.renderKind.toUpperCase()} file is not mounted in
        Station&apos;s trusted origin. The Browser pane opens pages from an
        http(s) address; this workspace file does not supply one.
      </p>
    );
  if (preview.renderKind !== 'source' && preview.renderKind !== 'text')
    return (
      <p role="status">
        This {preview.renderKind} preview is not supported in this initial
        source and plain-text renderer.
      </p>
    );
  return null;
}

function FilePreviewDownloadHandoff({
  projectSlug,
  path,
  thread,
}: {
  projectSlug: string;
  path: string;
  thread?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  return (
    <div>
      <button
        type="button"
        disabled={downloading}
        onClick={() => {
          setDownloading(true);
          setError(null);
          void downloadProjectWorkspaceFilePreview(projectSlug, path, thread)
            .then(({ bytes, filename }) => {
              // The attachment is always octet-stream. It is saved, never
              // navigated, mounted, proxied, or treated as trusted HTML/PDF.
              const copy = new Uint8Array(bytes.byteLength);
              copy.set(bytes);
              const objectUrl = URL.createObjectURL(
                new Blob([copy.buffer], { type: 'application/octet-stream' }),
              );
              const anchor = document.createElement('a');
              anchor.href = objectUrl;
              anchor.download = filename;
              anchor.click();
              URL.revokeObjectURL(objectUrl);
            })
            .catch(() => {
              setError('Station could not prepare this safe file download.');
            })
            .finally(() => setDownloading(false));
        }}
      >
        Download file
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

/**
 * github-dark's foregrounds (the one theme the shared highlighter loads)
 * mapped onto Station's measured syntax rungs. The theme's own pigments are
 * dark-only and fail contrast on the light theme (#2140), so the grammar
 * decides WHAT a token is and the Station theme decides how it looks. A
 * foreground absent here (the default text colour, brackets, invalid markers)
 * renders as ordinary text.
 */
const SYNTAX_RUNG_BY_THEME_FOREGROUND: Readonly<Record<string, string>> = {
  '#F97583': 'var(--syntax-keyword)',
  '#9ECBFF': 'var(--syntax-string)',
  '#DBEDFF': 'var(--syntax-string)',
  '#79B8FF': 'var(--syntax-number)',
  '#6A737D': 'var(--text-muted)',
  '#B392F0': 'var(--syntax-function)',
  '#85E89D': 'var(--syntax-tag)',
  '#FFAB70': 'var(--syntax-variable)',
};

type PreviewSyntax =
  | { status: 'off' }
  | { status: 'pending' }
  | { status: 'ready'; lines: readonly PreviewTokenLine[] }
  | { status: 'plain'; reason: string };

/**
 * Accepts Shiki's lines only when they reproduce the rendered text exactly:
 * same line count, and each line's tokens concatenating to that line (a CRLF
 * file's trailing `\r` is the one difference Shiki is allowed). Anything else
 * would show the reader text the file does not contain, so it is refused and
 * the preview stays plain.
 */
function acceptPreviewTokens(
  lines: readonly FilePreviewLineProjection[],
  tokens: readonly PreviewTokenLine[],
): PreviewSyntax {
  if (tokens.length !== lines.length)
    return {
      status: 'plain',
      reason:
        'Syntax colours are off: the highlighter split lines differently.',
    };
  let spans = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index].text;
    const joined = tokens[index].map((token) => token.content).join('');
    if (joined !== text && joined !== text.replace(/\r$/, ''))
      return {
        status: 'plain',
        reason:
          'Syntax colours are off: the highlighter did not reproduce this text exactly.',
      };
    for (const token of tokens[index])
      if (token.color && SYNTAX_RUNG_BY_THEME_FOREGROUND[token.color])
        spans += 1;
    if (spans > MAX_SOURCE_HIGHLIGHT_TOKENS)
      return {
        status: 'plain',
        reason: `Syntax colours are off: this preview has more than ${MAX_SOURCE_HIGHLIGHT_TOKENS.toLocaleString()} coloured tokens.`,
      };
  }
  return { status: 'ready', lines: tokens };
}

/**
 * Real grammar highlighting through the shared highlight worker (main thread
 * where no worker exists). Plain text is rendered until tokens arrive and
 * whenever they are refused; the reason is surfaced, never swallowed.
 */
function usePreviewSyntax(
  lines: readonly FilePreviewLineProjection[],
  lang: string | undefined,
  enabled: boolean,
): PreviewSyntax {
  const [syntax, setSyntax] = useState<PreviewSyntax>({ status: 'off' });
  useEffect(() => {
    if (!enabled || !lang || lines.length === 0) {
      setSyntax({ status: 'off' });
      return;
    }
    let current = true;
    setSyntax({ status: 'pending' });
    const code = lines.map((line) => line.text).join('\n');
    void import('../highlight/highlight-client')
      .then(({ tokenizeCode }) => tokenizeCode(code, lang))
      .then(
        (tokens) => {
          if (current) setSyntax(acceptPreviewTokens(lines, tokens));
        },
        () => {
          if (current)
            setSyntax({
              status: 'plain',
              reason:
                'Syntax colours are off: the highlighter did not answer for this file.',
            });
        },
      );
    return () => {
      current = false;
    };
  }, [enabled, lang, lines]);
  return syntax;
}

/** React text nodes preserve content literally; no workspace markup is parsed. */
function FilePreviewLineText({
  text,
  tokens,
}: {
  text: string;
  tokens?: PreviewTokenLine;
}) {
  if (!tokens) return text;
  return tokens.map((token, index) => {
    const rung = token.color
      ? SYNTAX_RUNG_BY_THEME_FOREGROUND[token.color]
      : undefined;
    return rung ? (
      <span
        // Tokens are positional within one immutable line.
        key={index}
        data-file-preview-token="true"
        style={{ color: rung }}
      >
        {token.content}
      </span>
    ) : (
      token.content
    );
  });
}

function PreviewRangeStatus({
  previewRange,
  requestedRange,
}: {
  previewRange?: WorkspaceFilePreviewLineRange;
  requestedRange?: WorkspaceFilePreviewLineRange;
}) {
  if (!previewRange && !requestedRange) return null;
  if (previewRange && sameRange(previewRange, requestedRange))
    return (
      <span role="status">
        Requested lines {previewRange.start}–{previewRange.end}
      </span>
    );
  return (
    <span role="status">
      {previewRange
        ? `Showing lines ${previewRange.start}–${previewRange.end}`
        : 'Showing the full preview'}
      {requestedRange
        ? `; requested ${requestedRange.start}–${requestedRange.end}`
        : ''}
    </span>
  );
}

function FilePreviewLine({
  line,
  stateKey,
  tokens,
}: {
  line: FilePreviewLineProjection;
  stateKey: string;
  tokens?: PreviewTokenLine;
}) {
  return (
    <span
      id={lineId(stateKey, line.number)}
      data-line={line.number}
      style={{
        display: 'block',
        background: line.requested ? 'var(--bg-selected)' : undefined,
      }}
    >
      <a
        href={`#${lineId(stateKey, line.number)}`}
        aria-label={`Link to line ${line.number}`}
        style={{
          color: 'var(--text-muted)',
          display: 'inline-block',
          minWidth: '3.5em',
          textAlign: 'right',
          marginRight: '1em',
          userSelect: 'none',
        }}
      >
        {line.number}
      </a>
      <FilePreviewLineText text={line.text} tokens={tokens} />
    </span>
  );
}

function useFilePreviewWrapController(
  stateKey: string,
  state: WorkspaceFilePreviewPaneState,
) {
  const [wrap, setWrap] = useState(state.wrap);
  useEffect(() => setWrap(state.wrap), [state.wrap]);
  const updateWrap = useCallback(
    (next: boolean) => {
      setWrap(next);
      writeFilePreviewPaneState(window.localStorage, stateKey, {
        ...latestMatchingFilePreviewState(stateKey, state),
        wrap: next,
      });
    },
    [state, stateKey],
  );
  return { wrap, updateWrap } as const;
}

function useFilePreviewMarkdownModeController(
  stateKey: string,
  state: WorkspaceFilePreviewPaneState,
) {
  const [preferredMode, setPreferredMode] = useState(
    state.markdownMode ?? 'rendered',
  );
  useEffect(
    () => setPreferredMode(state.markdownMode ?? 'rendered'),
    [state.markdownMode],
  );
  const updateMode = useCallback(
    (next: 'rendered' | 'source') => {
      setPreferredMode(next);
      writeFilePreviewPaneState(window.localStorage, stateKey, {
        ...latestMatchingFilePreviewState(stateKey, state),
        markdownMode: next,
      });
    },
    [state, stateKey],
  );
  return {
    preferredMode,
    mode: state.lineRange ? ('source' as const) : preferredMode,
    forcedSource: !!state.lineRange,
    updateMode,
  } as const;
}

/** The line-range status, when a range was asked for or returned. */
function FilePreviewRangeLine({
  preview,
  state,
}: {
  preview: WorkspaceFilePreview;
  state: WorkspaceFilePreviewPaneState;
}) {
  if (!preview.lineRange && !state.lineRange) return null;
  return (
    <p className="workspace-file-preview__notice">
      <PreviewRangeStatus
        previewRange={preview.lineRange}
        requestedRange={state.lineRange}
      />
    </p>
  );
}

/**
 * Go to line lives in the header's overflow menu (and ⌘G / Ctrl+G), but only
 * the source view knows which lines are rendered. The source view says it is
 * mounted; the header opens the popover it renders.
 */
const GoToLineContext = createContext<{
  open: boolean;
  close(): void;
  setAvailable(available: boolean): void;
}>({ open: false, close() {}, setAvailable() {} });

/**
 * The rendered-line cap, stated before the code rather than after it: a
 * reader of a long file must learn it is truncated without scrolling 2,000
 * lines to find out.
 */
function RenderedLineCapNotice({
  lines,
  totalLines,
}: {
  lines: readonly FilePreviewLineProjection[];
  totalLines: number;
}) {
  if (totalLines <= lines.length || lines.length === 0) return null;
  const first = lines[0].number;
  const last = lines.at(-1)?.number ?? first;
  return (
    <p role="status" className="workspace-file-preview__notice">
      Showing lines {first.toLocaleString()}–{last.toLocaleString()} of{' '}
      {totalLines.toLocaleString()}. This bounded preview renders at most{' '}
      {MAX_RENDERED_LINES.toLocaleString()} lines; the rest of the file is not
      shown here.
    </p>
  );
}

function FilePreviewGoToLine({
  lines,
  stateKey,
  onClose,
}: {
  lines: readonly FilePreviewLineProjection[];
  stateKey: string;
  onClose(): void;
}) {
  const [value, setValue] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const first = lines[0]?.number ?? 1;
  const last = lines.at(-1)?.number ?? first;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const line = Number(value);
    // Refuse rather than clamp: jumping to the nearest rendered line would
    // show the reader a line they did not ask for under the one they did.
    if (!Number.isInteger(line) || line < first || line > last) {
      setNotice(
        `Line ${value || '?'} is not among the rendered lines ${first.toLocaleString()}–${last.toLocaleString()}.`,
      );
      return;
    }
    const target = document.getElementById(lineId(stateKey, line));
    if (!target) {
      setNotice(`Line ${line} is not rendered.`);
      return;
    }
    setNotice(null);
    if (typeof target.scrollIntoView === 'function')
      target.scrollIntoView({ block: 'center' });
    target
      .querySelector<HTMLAnchorElement>('a')
      ?.focus({ preventScroll: true });
    onClose();
  };
  return (
    // noValidate: the refusal below names the rendered range; the browser's
    // own range bubble would pre-empt it with a message that does not.
    <form
      className="workspace-file-preview__goto"
      aria-label="Go to line"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose();
      }}
      noValidate
    >
      <label>
        Line
        <input
          type="number"
          inputMode="numeric"
          min={first}
          max={last}
          value={value}
          placeholder={`${first}–${last}`}
          // biome-ignore lint/a11y/noAutofocus: the popover exists to take this one input; the shortcut that opened it expects to type.
          autoFocus
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <Button type="submit" size="sm" disabled={!value}>
        Go
      </Button>
      <IconButton
        aria-label="Close go to line"
        title="Close (Esc)"
        onClick={onClose}
      >
        ×
      </IconButton>
      {notice && <span role="status">{notice}</span>}
    </form>
  );
}

function FilePreviewSourceLines({
  preview,
  state,
  stateKey,
  wrap,
}: {
  preview: WorkspaceFilePreview;
  state: WorkspaceFilePreviewPaneState;
  stateKey: string;
  wrap: boolean;
}) {
  const lines = useMemo(
    () => projectFilePreviewLines(preview, state),
    [preview, state],
  );
  const totalLines = useMemo(
    () => (preview.content ?? '').split('\n').length,
    [preview.content],
  );
  const revealLine = preview.lineRange?.start ?? state.lineRange?.start;
  const syntax = usePreviewSyntax(
    lines,
    langFromFilePath(state.path),
    preview.renderKind === 'source' ||
      (preview.renderKind === 'markdown' && !!preview.content),
  );
  useEffect(() => {
    if (revealLine === undefined) return;
    const target = document.getElementById(lineId(stateKey, revealLine));
    if (typeof target?.scrollIntoView === 'function')
      target.scrollIntoView({ block: 'center' });
  }, [revealLine, stateKey]);
  const goTo = useContext(GoToLineContext);
  const { setAvailable } = goTo;
  useEffect(() => {
    setAvailable(true);
    return () => setAvailable(false);
  }, [setAvailable]);

  return (
    <>
      <RenderedLineCapNotice lines={lines} totalLines={totalLines} />
      {syntax.status === 'plain' && (
        <p role="status" className="workspace-file-preview__notice">
          {syntax.reason}
        </p>
      )}
      {goTo.open && (
        <FilePreviewGoToLine
          lines={lines}
          stateKey={stateKey}
          onClose={goTo.close}
        />
      )}
      <section
        aria-label={`${state.path} source`}
        aria-busy={syntax.status === 'pending' || undefined}
        data-file-preview-syntax={syntax.status}
      >
        <pre
          className="workspace-file-preview__code"
          style={{ whiteSpace: wrap ? 'pre-wrap' : 'pre' }}
        >
          <code>
            {lines.map((line, index) => (
              <FilePreviewLine
                key={line.number}
                line={line}
                stateKey={stateKey}
                tokens={
                  syntax.status === 'ready' ? syntax.lines[index] : undefined
                }
              />
            ))}
          </code>
        </pre>
      </section>
    </>
  );
}

function ReadyPreview(props: {
  preview: WorkspaceFilePreview;
  state: WorkspaceFilePreviewPaneState;
  stateKey: string;
  wrap: boolean;
}) {
  return (
    <>
      <FilePreviewRangeLine preview={props.preview} state={props.state} />
      <FilePreviewSourceLines {...props} />
    </>
  );
}

function MarkdownPreviewToolbar({
  preview,
  state,
  mode,
  forcedSource,
  updateMode,
}: {
  preview: WorkspaceFilePreview;
  state: WorkspaceFilePreviewPaneState;
  mode: 'rendered' | 'source';
  forcedSource: boolean;
  updateMode(next: 'rendered' | 'source'): void;
}) {
  return (
    <div className="workspace-file-preview__toolbar">
      <fieldset className="workspace-file-preview__segmented">
        <legend className="workspace-file-preview__visually-hidden">
          Markdown preview mode
        </legend>
        <button
          type="button"
          aria-pressed={mode === 'rendered'}
          disabled={forcedSource}
          onClick={() => updateMode('rendered')}
        >
          Rendered
        </button>
        <button
          type="button"
          aria-pressed={mode === 'source'}
          onClick={() => updateMode('source')}
        >
          Source
        </button>
      </fieldset>
      <PreviewRangeStatus
        previewRange={preview.lineRange}
        requestedRange={state.lineRange}
      />
      {forcedSource && (
        <span role="status">Line reveal uses the accurate source view.</span>
      )}
    </div>
  );
}

function isRenderedMarkdownWithinBudget(content: string): boolean {
  if (content.length > MAX_RENDERED_MARKDOWN_CHARACTERS) return false;
  let lines = 1;
  let syntaxTokens = 0;
  let bracketDepth = 0;
  let delimiterRun = 0;
  let previousCharacter = '';
  for (const character of content) {
    if (character === '\n') lines += 1;
    if (MARKDOWN_SYNTAX_CHARACTERS.has(character)) syntaxTokens += 1;
    if (character === '[' || character === '(') bracketDepth += 1;
    if (character === ']' || character === ')')
      bracketDepth = Math.max(0, bracketDepth - 1);
    if ('*_~`>'.includes(character) && character === previousCharacter)
      delimiterRun += 1;
    else delimiterRun = 1;
    previousCharacter = character;
    if (
      lines > MAX_RENDERED_MARKDOWN_LINES ||
      syntaxTokens > MAX_RENDERED_MARKDOWN_SYNTAX_TOKENS ||
      bracketDepth > MAX_RENDERED_MARKDOWN_NESTING ||
      delimiterRun > MAX_RENDERED_MARKDOWN_DELIMITER_RUN
    )
      return false;
  }
  for (const line of content.split('\n')) {
    let cursor = 0;
    let indentation = 0;
    while (line[cursor] === ' ' || line[cursor] === '\t') {
      indentation += line[cursor] === '\t' ? 4 : 1;
      cursor += 1;
    }
    if (indentation > MAX_RENDERED_MARKDOWN_NESTING * 4) return false;
    // Containers can be interleaved without indentation (for example,
    // "- > ".repeat(1024)). Count the full run before handing it to
    // ReactMarkdown, otherwise a small input can create a deeply recursive
    // tree. The sticky expression advances on the original line, keeping this
    // preflight linear rather than repeatedly allocating sliced substrings.
    let containerDepth = 0;
    while (cursor < line.length) {
      while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
      if (line[cursor] === '>') {
        cursor += 1;
      } else {
        MARKDOWN_LIST_MARKER.lastIndex = cursor;
        if (!MARKDOWN_LIST_MARKER.exec(line)) break;
        cursor = MARKDOWN_LIST_MARKER.lastIndex;
      }
      containerDepth += 1;
      if (containerDepth > MAX_RENDERED_MARKDOWN_NESTING) return false;
    }
  }
  return true;
}

function InertRenderedMarkdown({ content }: { content: string }) {
  if (!isRenderedMarkdownWithinBudget(content))
    return (
      <p role="status">
        This Markdown is too complex for the bounded rendered view. Use Source
        to inspect it safely.
      </p>
    );
  return (
    <Suspense
      fallback={
        <SkeletonBlock
          count={3}
          label="Loading bounded rendered Markdown preview"
        />
      }
    >
      <LazyInertRenderedMarkdown content={content} />
    </Suspense>
  );
}

function ReadyMarkdownPreview(props: {
  preview: WorkspaceFilePreview;
  state: WorkspaceFilePreviewPaneState;
  stateKey: string;
  wrap: boolean;
}) {
  const { mode, forcedSource, updateMode } =
    useFilePreviewMarkdownModeController(props.stateKey, props.state);
  return (
    <>
      <MarkdownPreviewToolbar
        preview={props.preview}
        state={props.state}
        mode={mode}
        forcedSource={forcedSource}
        updateMode={updateMode}
      />
      {mode === 'source' ? (
        <FilePreviewSourceLines {...props} />
      ) : (
        <InertRenderedMarkdown content={props.preview.content ?? ''} />
      )}
    </>
  );
}

function ReadyImagePreview({
  preview,
  path,
}: {
  preview: WorkspaceFilePreview;
  path: string;
}) {
  if (!isWorkspaceFilePreviewImageDataUrl(preview.dataUrl, preview.mimeType))
    return (
      <p role="alert">
        Station rejected this image because its bounded preview payload was not
        valid.
      </p>
    );
  return (
    <BoundedPngImage
      key={preview.dataUrl}
      dataUrl={preview.dataUrl}
      path={path}
      sizeBytes={preview.sizeBytes}
    />
  );
}

function BoundedPngImage({
  dataUrl,
  path,
  sizeBytes,
}: {
  dataUrl: string;
  path: string;
  sizeBytes?: number;
}) {
  return (
    <figure
      style={{
        margin: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <ImageInspector
        key={dataUrl}
        src={dataUrl}
        name={`Preview of ${path}`}
        errorMessage="This image passed the bounded preview checks but could not be decoded."
      />
      <figcaption style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
        PNG · {sizeBytes ?? 0} bytes
      </figcaption>
    </figure>
  );
}

function PreviewContent(props: {
  preview: WorkspaceFilePreview;
  state: WorkspaceFilePreviewPaneState;
  stateKey: string;
  wrap: boolean;
}) {
  const status = <PreviewStatus preview={props.preview} />;
  return props.preview.status === 'ready' &&
    (props.preview.renderKind === 'source' ||
      props.preview.renderKind === 'text') ? (
    <ReadyPreview {...props} />
  ) : props.preview.status === 'ready' &&
    props.preview.renderKind === 'image' ? (
    <ReadyImagePreview preview={props.preview} path={props.state.path} />
  ) : props.preview.status === 'ready' &&
    props.preview.renderKind === 'markdown' ? (
    <ReadyMarkdownPreview {...props} />
  ) : props.preview.status === 'ready' &&
    (props.preview.renderKind === 'html' ||
      props.preview.renderKind === 'pdf') ? (
    <>
      {status}
      <FilePreviewDownloadHandoff
        projectSlug={props.state.projectSlug}
        path={props.state.path}
        thread={props.state.thread}
      />
    </>
  ) : (
    status
  );
}

const loadObservedDiff = () =>
  import('../components/coding-layout/DiffPanel').then((module) => ({
    default: module.ObservedDiffPanel,
  }));

/**
 * This file's changes against HEAD, rendered by the same diff surface as the
 * Diff pane. Read only while the view is open (it runs `git diff` on the
 * host), and every state the server distinguishes is said in words; none is
 * shown as an empty diff.
 */
function FilePreviewChanges({
  projectSlug,
  path,
  thread,
}: {
  projectSlug: string;
  path: string;
  thread?: string;
}) {
  const query = useProjectWorkspaceFileChangesQuery(projectSlug, {
    path,
    ...(thread ? { thread } : {}),
  });
  if (query.isLoading)
    return <SkeletonBlock count={3} label="Reading changes against HEAD" />;
  if (isRepositoryBusyError(query.error))
    // Not a refusal and nothing wrong with the file: the repository was
    // being written each time Station read it (the query already asked
    // again), and a read is only answered from one that held still.
    return (
      <div role="status">
        <p>
          The repository was being changed while Station read it. Nothing is
          wrong with it; try again in a moment.
        </p>
        <Button size="sm" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  if (query.isError || !query.data)
    return (
      <div role="alert">
        <p>Station could not read this file's changes.</p>
        <Button size="sm" onClick={() => void query.refetch()}>
          Retry changes
        </Button>
      </div>
    );
  const changes = query.data;
  switch (changes.state) {
    case 'changed':
      return (
        <section
          aria-label={`${path} changes against HEAD`}
          className="workspace-file-preview__changes"
        >
          <LazyBoundary
            load={loadObservedDiff}
            componentProps={{
              diff: changes.patch,
              observationKey: `file-changes:${projectSlug}:${thread ?? ''}:${path}`,
            }}
            pending={<SkeletonBlock label="Preparing changes" />}
          />
        </section>
      );
    case 'unchanged':
      return (
        <p role="status">
          No changes: this file matches the last commit (HEAD).
        </p>
      );
    case 'untracked':
      return (
        <p role="status">
          This file is not tracked by git, so there is no committed version to
          compare it with.
        </p>
      );
    case 'no-commits':
      return (
        <p role="status">
          This repository has no commits yet, so there is no HEAD to compare
          with.
        </p>
      );
    case 'not-a-repository':
      return <p role="status">This file is not inside a git repository.</p>;
    case 'oversized':
      return (
        <ErrorState
          variant="compact"
          title="Changes too large"
          description={`This file's changes exceed the ${Math.round(changes.limitBytes / 1024)} KB in-app limit. Use the Diff pane or git to review them.`}
        />
      );
    case 'refused':
      return (
        <ErrorState
          variant="compact"
          title="Changes not read"
          description={changes.reason}
        />
      );
  }
}

type FilePreviewView = 'file' | 'changes';

/** Lines a patch adds or removes, excluding its file headers. */
function changedLineCount(patch: string): number {
  let count = 0;
  for (const line of patch.split('\n'))
    if (
      (line.startsWith('+') && !line.startsWith('+++')) ||
      (line.startsWith('-') && !line.startsWith('---'))
    )
      count += 1;
  return count;
}

/**
 * The path as a quiet breadcrumb: project and folders muted and allowed to
 * truncate, the file name bold and always whole. The full path and its type
 * are the tooltip.
 */
function FilePreviewBreadcrumb({
  projectSlug,
  path,
  detail,
}: {
  projectSlug: string;
  path: string;
  detail: string;
}) {
  const segments = path.split('/');
  const file = segments.pop() || path;
  return (
    <nav
      className="workspace-file-preview__crumbs"
      aria-label="File path"
      title={`${projectSlug} / ${path} · ${detail}`}
    >
      <span className="workspace-file-preview__crumbs-lead">
        {[projectSlug, ...segments].map((segment, index) => (
          // Positional: the same folder name can repeat along one path.
          <span key={index}>
            {segment}
            <span
              className="workspace-file-preview__crumb-sep"
              aria-hidden="true"
            >
              /
            </span>
          </span>
        ))}
      </span>
      <strong className="workspace-file-preview__crumb-file">{file}</strong>
    </nav>
  );
}

/** A data-only, project-bound source/text renderer. Host chrome owns close and tabs. */
export function FilePreviewPane({
  projectSlug,
  stateKey,
  state,
}: {
  projectSlug: string;
  stateKey: string;
  state: WorkspaceFilePreviewPaneState;
}) {
  const performanceSurfaceRef = useRef<HTMLDivElement | null>(null);
  const [completedRefresh, setCompletedRefresh] =
    useState<FilePreviewRefresh>();
  const completedRefreshNonce =
    completedRefresh?.projectSlug === state.projectSlug &&
    completedRefresh.path === state.path
      ? completedRefresh.nonce
      : undefined;
  const { navigate, selectedProjectLayout } = useNavigation();
  const { addFile, has, removeFile } = useCodingFilesContext();
  const catalog = useResolvedWorkspacePaneCatalog(projectSlug);
  const [contextNotice, setContextNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const { wrap, updateWrap } = useFilePreviewWrapController(stateKey, state);
  const [gotoOpen, setGotoOpen] = useState(false);
  const [gotoAvailable, setGotoAvailable] = useState(false);
  const goToLine = useMemo(
    () => ({
      open: gotoOpen && gotoAvailable,
      close: () => setGotoOpen(false),
      setAvailable: setGotoAvailable,
    }),
    [gotoAvailable, gotoOpen],
  );
  // Per path: a different file opens on its content, not a stale Changes view.
  const [viewFor, setViewFor] = useState<{
    path: string;
    view: FilePreviewView;
  }>({ path: state.path, view: 'file' });
  const view = viewFor.path === state.path ? viewFor.view : 'file';
  const previewRequest = {
    path: state.path,
    ...(state.lineRange ? { lineRange: state.lineRange } : {}),
    ...(state.thread ? { thread: state.thread } : {}),
  };
  const query = useProjectWorkspaceFilePreviewQuery(
    projectSlug,
    previewRequest,
  );
  const measurementFetching =
    (import.meta.env.MODE === 'test' ||
      import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE === '1') &&
    query.isFetching;
  const textual =
    query.data?.status === 'ready' &&
    ['source', 'text', 'markdown'].includes(query.data.renderKind);
  // The Changes toggle's pip needs the answer before the view is opened; the
  // Changes view reads the same cached query.
  const changesQuery = useProjectWorkspaceFileChangesQuery(
    projectSlug,
    { path: state.path, ...(state.thread ? { thread: state.thread } : {}) },
    { enabled: textual, staleTime: 15_000 },
  );
  const changedLines =
    changesQuery.data?.state === 'changed'
      ? changedLineCount(changesQuery.data.patch)
      : 0;
  const intent = parseWorkspaceOpenFilePreviewIntent({
    projectSlug: state.projectSlug,
    path: state.path,
    ...(state.lineRange ? { lineRange: state.lineRange } : {}),
  });
  const fileBrowser = catalog.entries.find(
    (entry) =>
      entry.descriptor.renderer?.kind === 'builtin-component' &&
      entry.descriptor.renderer.name ===
        WORKSPACE_CODING_FILE_BROWSER_PANE_RENDERER_NAME &&
      entry.instance,
  );
  const revealRoute =
    intent && fileBrowser?.instance
      ? workspacePaneDirectRoute(
          projectSlug,
          fileBrowser.descriptor,
          fileBrowser.instance,
          selectedProjectLayout,
        )
      : null;
  const directLink = intent
    ? openFilePreviewDirectLink(intent, selectedProjectLayout)
    : null;
  const attachedToConversation = intent ? has(intent) : false;

  const addToConversation = () => {
    if (!intent || !query.data || !addFile(intent, query.data)) {
      setContextNotice(
        'This preview cannot be added to the active conversation.',
      );
      return;
    }
    setContextNotice('Added to the active conversation.');
  };

  const removeFromConversation = () => {
    if (!intent) return;
    removeFile(intent);
    setContextNotice('Removed from the active conversation.');
  };

  useLayoutEffect(() => {
    if (
      import.meta.env.MODE !== 'test' &&
      import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE !== '1'
    )
      return;
    const preview = query.data;
    if (
      query.isLoading ||
      measurementFetching ||
      query.isError ||
      preview?.status !== 'ready' ||
      preview.sizeBytes === undefined ||
      preview.lineCount === undefined ||
      !performanceSurfaceRef.current
    )
      return;
    performanceSurfaceRef.current.getBoundingClientRect();
    emitFilePreviewCommitPerformanceMark({
      projectSlug: state.projectSlug,
      path: state.path,
      sizeBytes: preview.sizeBytes,
      lineCount: preview.lineCount,
      renderedLineCount: Math.min(preview.lineCount, MAX_RENDERED_LINES),
      ...(completedRefreshNonce ? { refreshNonce: completedRefreshNonce } : {}),
      committedEpochMs: browserEpochMs(),
    });
    if (completedRefreshNonce) {
      setCompletedRefresh(undefined);
    }
  }, [
    completedRefreshNonce,
    query.data,
    query.isLoading,
    measurementFetching,
    query.isError,
    state.path,
    state.projectSlug,
  ]);

  const copyPath = () => {
    void copyToClipboard(state.path).then((ok) => {
      window.clearTimeout(copiedTimer.current);
      if (!ok) {
        setCopied(false);
        setContextNotice(
          'This browser refused clipboard access. Select the path to copy it.',
        );
        return;
      }
      setContextNotice(null);
      setCopied(true);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
    });
  };

  const copyDirectLink = () => {
    if (!directLink || !navigator.clipboard) {
      setContextNotice('A shareable preview link is unavailable here.');
      return;
    }
    void navigator.clipboard
      .writeText(new URL(directLink, window.location.origin).toString())
      .then(() => setContextNotice('Copied the preview link.'))
      .catch(() =>
        setContextNotice('Station could not copy the preview link.'),
      );
  };

  const headSlots = usePaneHeadSlots();
  const segmented = textual ? (
    <fieldset className="workspace-file-preview__segmented">
      <legend className="workspace-file-preview__visually-hidden">
        Preview view
      </legend>
      <button
        type="button"
        aria-pressed={view === 'file'}
        title="The file as it is now"
        onClick={() => setViewFor({ path: state.path, view: 'file' })}
      >
        File
      </button>
      <button
        type="button"
        aria-pressed={view === 'changes'}
        aria-label={
          changedLines > 0
            ? `Changes vs HEAD, ${changedLines} changed line${changedLines === 1 ? '' : 's'}`
            : 'Changes vs HEAD'
        }
        title="Changes against the last commit (HEAD)"
        onClick={() => setViewFor({ path: state.path, view: 'changes' })}
      >
        Changes
        {changedLines > 0 && (
          <span className="workspace-file-preview__pip" aria-hidden="true">
            {changedLines > 99 ? '99+' : changedLines}
          </span>
        )}
      </button>
    </fieldset>
  ) : null;
  const barActions = (
    <>
      <IconButton
        className="workspace-file-preview__icon"
        aria-label={copied ? 'Path copied' : 'Copy path'}
        title={copied ? 'Copied' : `Copy path (${state.path})`}
        onClick={copyPath}
      >
        {copied ? <CheckGlyph /> : <CopyGlyph />}
      </IconButton>
      <ActionOverflowMenu
        label="More file actions"
        triggerClassName="icon-button workspace-file-preview__icon"
        actions={[
          {
            key: 'reveal',
            label: 'Reveal in Files',
            disabled: !revealRoute,
            onSelect: () => {
              if (!revealRoute || !intent) return;
              const params = serializeOpenFilePreviewIntent(intent);
              if (params) navigate(revealRoute, params);
            },
          },
          {
            key: 'link',
            label: 'Copy preview link',
            disabled: !directLink,
            onSelect: copyDirectLink,
          },
          {
            key: 'conversation',
            label: attachedToConversation
              ? 'Remove from conversation'
              : 'Add to conversation',
            disabled:
              !intent ||
              (!attachedToConversation && query.data?.status !== 'ready'),
            onSelect: attachedToConversation
              ? removeFromConversation
              : addToConversation,
          },
          {
            key: 'wrap',
            label: 'Wrap lines',
            checked: wrap,
            glyph: wrap ? <CheckGlyph /> : undefined,
            onSelect: () => updateWrap(!wrap),
          },
          {
            key: 'goto',
            label: 'Go to line…',
            shortcut: GO_TO_LINE_SHORTCUT,
            disabled: !gotoAvailable || view !== 'file',
            onSelect: () => setGotoOpen(true),
          },
          // The host's own rows for this pane (pop out, remove), merged so
          // the head has one ⋯; `takeHostActions` below tells it so.
          ...(headSlots?.hostActions ?? []),
        ]}
      />
    </>
  );
  const takeHostActions = headSlots?.takeHostActions;
  useEffect(() => {
    if (!takeHostActions) return;
    takeHostActions(true);
    return () => takeHostActions(false);
  }, [takeHostActions]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a scoped keyboard shortcut (⌘G / Ctrl+G) for the pane's focused content, not a control.
    <div
      className="workspace-file-preview"
      onKeyDown={(event: ReactKeyboardEvent) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          // Shift+⌘G is the browser's "find previous"; leave it alone.
          !event.shiftKey &&
          event.key.toLowerCase() === 'g' &&
          gotoAvailable &&
          view === 'file'
        ) {
          event.preventDefault();
          setGotoOpen(true);
        }
      }}
    >
      {import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE ===
      '1' ? (
        <ReferenceFilePreviewRefresh
          projectSlug={projectSlug}
          path={state.path}
          refetch={query.refetch}
          completed={setCompletedRefresh}
        />
      ) : null}
      {headSlots ? (
        // Inside a host that draws the pane's head itself (the Coding
        // layout's side panel), the head's title is the file's name and its
        // tooltip the path, so the crumbs would say it twice: the view
        // toggle joins the head after the name and the actions join it
        // before the host's close, and the pane draws no bar of its own.
        <>
          {headSlots.leading
            ? createPortal(segmented, headSlots.leading)
            : null}
          {headSlots.trailing
            ? createPortal(barActions, headSlots.trailing)
            : null}
        </>
      ) : (
        <div className="workspace-file-preview__bar">
          <FilePreviewBreadcrumb
            projectSlug={state.projectSlug}
            path={state.path}
            detail={
              query.data?.mimeType ?? langFromFilePath(state.path) ?? 'text'
            }
          />
          {segmented}
          {barActions}
        </div>
      )}
      {contextNotice && (
        <p role="status" className="workspace-file-preview__status">
          {contextNotice}
        </p>
      )}
      <div
        ref={performanceSurfaceRef}
        data-station-performance-surface="workspace-file-preview"
        data-station-project-slug={state.projectSlug}
        data-station-file-path={state.path}
        style={{
          // Fills the pane below the one-row header; the pane host bounds it.
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '4px 12px 12px',
        }}
        onScroll={(event) => {
          if (
            import.meta.env.MODE !== 'test' &&
            import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE !==
              '1'
          )
            return;
          const surface = event.currentTarget;
          const scrolledEpochMs =
            event.timeStamp >= performance.timeOrigin
              ? event.timeStamp
              : performance.timeOrigin + event.timeStamp;
          requestAnimationFrame(() => {
            if (
              !surface.isConnected ||
              surface.dataset.stationFilePath !== state.path ||
              surface.dataset.stationProjectSlug !== state.projectSlug
            )
              return;
            surface.getBoundingClientRect();
            emitFilePreviewScrollPerformanceMark({
              projectSlug: state.projectSlug,
              path: state.path,
              scrollTop: surface.scrollTop,
              scrolledEpochMs,
              committedEpochMs: browserEpochMs(),
            });
          });
        }}
      >
        {query.isLoading ? (
          <SkeletonBlock count={3} label="Loading preview" />
        ) : query.isError ? (
          <div role="alert">
            <p>Unable to load this Project file preview.</p>
            <button type="button" onClick={() => void query.refetch()}>
              Retry preview
            </button>
          </div>
        ) : query.data && view === 'changes' ? (
          <PaneHeadSlotsContext.Provider value={null}>
            <FilePreviewChanges
              projectSlug={projectSlug}
              path={state.path}
              thread={state.thread}
            />
          </PaneHeadSlotsContext.Provider>
        ) : query.data ? (
          <GoToLineContext.Provider value={goToLine}>
            <PreviewContent
              preview={query.data}
              state={state}
              stateKey={stateKey}
              wrap={wrap}
            />
          </GoToLineContext.Provider>
        ) : (
          <div role="status">
            <Empty
              variant="compact"
              label="Nothing to preview"
              description="Station has not produced a preview for this file."
            />
          </div>
        )}
      </div>
    </div>
  );
}
