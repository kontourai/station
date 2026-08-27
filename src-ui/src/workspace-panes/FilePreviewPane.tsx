import { WORKSPACE_CODING_FILE_BROWSER_PANE_RENDERER_NAME } from '@kontourai/station-contracts/workspace-coding-panels';
import { parseWorkspaceOpenFilePreviewIntent } from '@kontourai/station-contracts/workspace-file-preview';
import {
  downloadProjectWorkspaceFilePreview,
  isWorkspaceFilePreviewImageDataUrl,
  useProjectWorkspaceFilePreviewQuery,
  WORKSPACE_FILE_PREVIEW_MAX_BYTES,
  type WorkspaceFilePreview,
  type WorkspaceFilePreviewLineRange,
  type WorkspaceFilePreviewPaneState,
  type WorkspaceFilePreviewStatus,
} from '@kontourai/station-sdk/workspace-file-preview';
import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Empty, SkeletonBlock } from '../components/state';
import { useNavigation } from '../contexts/NavigationContext';
import { langFromFilePath } from '../contexts/SyntaxHighlighterContext';
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
import { useResolvedWorkspacePaneCatalog } from './resolvedWorkspacePaneCatalog';
import { workspacePaneDirectRoute } from './workspacePaneDirectRoute';

const MAX_RENDERED_LINES = 2_000;
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
export const MAX_SOURCE_HIGHLIGHT_TOKENS = 1_024;
export const MAX_SOURCE_HIGHLIGHT_REACT_NODES = 2_048;

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

function ReferenceFilePreviewRefresh({
  projectSlug,
  path,
  queryKey,
  completed,
}: {
  projectSlug: string;
  path: string;
  queryKey: QueryKey;
  completed(nonce: string): void;
}) {
  const queryClient = useQueryClient();
  useEffect(() => {
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
      // Exact key only: a reference corpus rebuild must not refresh unrelated
      // files, and a cached response can never count as the sample.
      void queryClient
        .invalidateQueries({ queryKey, exact: true })
        .then(() =>
          queryClient.refetchQueries({ queryKey, exact: true, type: 'active' }),
        )
        .then(() => completed(nonce));
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
  }, [completed, path, projectSlug, queryClient, queryKey]);
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
export function projectFilePreviewLines(
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
        Station&apos;s trusted origin. Browser Preview accepts a separately
        configured, validated local address; this workspace file does not supply
        one.
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
}: {
  projectSlug: string;
  path: string;
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
          void downloadProjectWorkspaceFilePreview(projectSlug, path)
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

type SourceTokenKind = 'comment' | 'keyword' | 'number' | 'string';
const SOURCE_TOKEN =
  /(\/\/.*$|#.*$|\/\*.*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:async|await|class|const|else|export|extends|false|for|function|if|import|interface|let|new|null|return|throw|true|type|undefined|while)\b|\b\d+(?:\.\d+)?\b)/g;

function tokenKind(token: string): SourceTokenKind {
  if (token.startsWith('//') || token.startsWith('#') || token.startsWith('/*'))
    return 'comment';
  if (/^\d/.test(token)) return 'number';
  if (/^["'`]/.test(token)) return 'string';
  return 'keyword';
}

const TOKEN_COLOR: Record<SourceTokenKind, string> = {
  comment: 'var(--text-muted)',
  keyword: '#ff7b72',
  number: '#79c0ff',
  string: '#a5d6ff',
};

/** React text nodes preserve content literally; no workspace markup is parsed. */
export function highlightFilePreviewLine(
  line: string,
  enabled: boolean,
): ReactNode {
  if (!enabled) return line;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let tokens = 0;
  for (const match of line.matchAll(SOURCE_TOKEN)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(line.slice(cursor, index));
    const token = match[0];
    tokens += 1;
    if (
      tokens > MAX_SOURCE_HIGHLIGHT_TOKENS ||
      nodes.length + 1 > MAX_SOURCE_HIGHLIGHT_REACT_NODES
    )
      return line;
    nodes.push(
      <span
        key={`${index}:${token.length}`}
        data-file-preview-token="true"
        style={{ color: TOKEN_COLOR[tokenKind(token)] }}
      >
        {token}
      </span>,
    );
    cursor = index + token.length;
  }
  if (cursor < line.length) nodes.push(line.slice(cursor));
  return nodes;
}

/** Preflights the whole response so token-dense content gets one inert text node. */
export function shouldHighlightFilePreviewLines(
  lines: readonly FilePreviewLineProjection[],
  source: boolean,
): boolean {
  if (!source) return false;
  let tokens = 0;
  let nodes = 0;
  for (const line of lines) {
    let cursor = 0;
    for (const match of line.text.matchAll(SOURCE_TOKEN)) {
      const index = match.index ?? 0;
      if (index > cursor) nodes += 1;
      tokens += 1;
      nodes += 1;
      if (
        tokens > MAX_SOURCE_HIGHLIGHT_TOKENS ||
        nodes > MAX_SOURCE_HIGHLIGHT_REACT_NODES
      )
        return false;
      cursor = index + match[0].length;
    }
    if (cursor < line.text.length) nodes += 1;
    if (nodes > MAX_SOURCE_HIGHLIGHT_REACT_NODES) return false;
  }
  return true;
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
  highlight,
}: {
  line: FilePreviewLineProjection;
  stateKey: string;
  highlight: boolean;
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
      {highlightFilePreviewLine(line.text, highlight)}
    </span>
  );
}

export function useFilePreviewWrapController(
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

export function useFilePreviewMarkdownModeController(
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

function FilePreviewToolbar({
  preview,
  state,
  wrap,
  updateWrap,
}: {
  preview: WorkspaceFilePreview;
  state: WorkspaceFilePreviewPaneState;
  wrap: boolean;
  updateWrap(next: boolean): void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginBottom: '6px',
        fontSize: '11px',
      }}
    >
      <label>
        <input
          type="checkbox"
          checked={wrap}
          onChange={(event) => updateWrap(event.target.checked)}
        />{' '}
        Wrap lines
      </label>
      <PreviewRangeStatus
        previewRange={preview.lineRange}
        requestedRange={state.lineRange}
      />
    </div>
  );
}

export function FilePreviewSourceLines({
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
  const revealLine = preview.lineRange?.start ?? state.lineRange?.start;
  const highlight = useMemo(
    () =>
      shouldHighlightFilePreviewLines(lines, preview.renderKind === 'source'),
    [lines, preview.renderKind],
  );
  useEffect(() => {
    if (revealLine === undefined) return;
    const target = document.getElementById(lineId(stateKey, revealLine));
    if (typeof target?.scrollIntoView === 'function')
      target.scrollIntoView({ block: 'center' });
  }, [revealLine, stateKey]);

  return (
    <>
      <section aria-label={`${state.path} source`}>
        <pre
          style={{
            margin: 0,
            fontFamily: 'monospace',
            fontSize: '11px',
            color: 'var(--text-secondary)',
            whiteSpace: wrap ? 'pre-wrap' : 'pre',
            overflowX: 'auto',
          }}
        >
          <code>
            {lines.map((line) => (
              <FilePreviewLine
                key={line.number}
                line={line}
                stateKey={stateKey}
                highlight={highlight}
              />
            ))}
          </code>
        </pre>
      </section>
      {(preview.content ?? '').split('\n').length > MAX_RENDERED_LINES && (
        <p role="status">
          Only the first {MAX_RENDERED_LINES} lines are rendered in this bounded
          preview.
        </p>
      )}
    </>
  );
}

function ReadyPreview(props: {
  preview: WorkspaceFilePreview;
  state: WorkspaceFilePreviewPaneState;
  stateKey: string;
}) {
  const { wrap, updateWrap } = useFilePreviewWrapController(
    props.stateKey,
    props.state,
  );
  return (
    <>
      <FilePreviewToolbar
        preview={props.preview}
        state={props.state}
        wrap={wrap}
        updateWrap={updateWrap}
      />
      <FilePreviewSourceLines {...props} wrap={wrap} />
    </>
  );
}

function MarkdownPreviewToolbar({
  preview,
  state,
  mode,
  forcedSource,
  wrap,
  updateMode,
  updateWrap,
}: {
  preview: WorkspaceFilePreview;
  state: WorkspaceFilePreviewPaneState;
  mode: 'rendered' | 'source';
  forcedSource: boolean;
  wrap: boolean;
  updateMode(next: 'rendered' | 'source'): void;
  updateWrap(next: boolean): void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '8px',
        marginBottom: '8px',
        fontSize: '11px',
      }}
    >
      <fieldset
        style={{
          border: 0,
          padding: 0,
          margin: 0,
          display: 'inline-flex',
        }}
      >
        <legend
          style={{
            position: 'absolute',
            width: '1px',
            height: '1px',
            overflow: 'hidden',
            clip: 'rect(0 0 0 0)',
          }}
        >
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
      {mode === 'source' && (
        <label>
          <input
            type="checkbox"
            checked={wrap}
            onChange={(event) => updateWrap(event.target.checked)}
          />{' '}
          Wrap lines
        </label>
      )}
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

export function isRenderedMarkdownWithinBudget(content: string): boolean {
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
}) {
  const { wrap, updateWrap } = useFilePreviewWrapController(
    props.stateKey,
    props.state,
  );
  const { mode, forcedSource, updateMode } =
    useFilePreviewMarkdownModeController(props.stateKey, props.state);
  return (
    <>
      <MarkdownPreviewToolbar
        preview={props.preview}
        state={props.state}
        mode={mode}
        forcedSource={forcedSource}
        wrap={wrap}
        updateMode={updateMode}
        updateWrap={updateWrap}
      />
      {mode === 'source' ? (
        <FilePreviewSourceLines {...props} wrap={wrap} />
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
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <p role="alert">
        This image passed the bounded preview checks but could not be decoded.
      </p>
    );
  return (
    <figure style={{ margin: 0, height: '100%' }}>
      <img
        src={dataUrl}
        alt={`Preview of ${path}`}
        onError={() => setFailed(true)}
        style={{
          display: 'block',
          maxWidth: '100%',
          maxHeight: '100%',
          margin: '0 auto',
          objectFit: 'contain',
        }}
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
      />
    </>
  ) : (
    status
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
  const refreshNonceRef = useRef<string | undefined>(undefined);
  const [completedRefreshNonce, setCompletedRefreshNonce] = useState<
    string | undefined
  >();
  const { navigate, selectedProjectLayout } = useNavigation();
  const { addFile, has, removeFile } = useCodingFilesContext();
  const catalog = useResolvedWorkspacePaneCatalog(projectSlug);
  const [contextNotice, setContextNotice] = useState<string | null>(null);
  const previewRequest = {
    path: state.path,
    ...(state.lineRange ? { lineRange: state.lineRange } : {}),
  };
  const previewQueryKey = [
    'projects',
    projectSlug,
    'file-preview',
    previewRequest,
  ] as const;
  const query = useProjectWorkspaceFilePreviewQuery(
    projectSlug,
    previewRequest,
  );
  const fileName = state.path.split('/').pop() || state.path;
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
      refreshNonceRef.current = undefined;
      setCompletedRefreshNonce(undefined);
    }
  }, [completedRefreshNonce, query.data, state.path, state.projectSlug]);

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

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE ===
      '1' ? (
        <ReferenceFilePreviewRefresh
          projectSlug={projectSlug}
          path={state.path}
          queryKey={previewQueryKey}
          completed={(nonce) => {
            refreshNonceRef.current = nonce;
            setCompletedRefreshNonce(nonce);
          }}
        />
      ) : null}
      <div style={{ padding: '6px 12px 4px', flexShrink: 0 }}>
        <div
          style={{
            fontSize: '11px',
            fontWeight: 600,
            color: 'var(--text-muted)',
          }}
        >
          {state.projectSlug} / {state.path}
        </div>
        <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
          {fileName} ·{' '}
          {query.data?.mimeType ?? langFromFilePath(state.path) ?? 'text'}
        </div>
        <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
          <button
            type="button"
            onClick={() => {
              if (!revealRoute || !intent) return;
              const params = serializeOpenFilePreviewIntent(intent);
              if (params) navigate(revealRoute, params);
            }}
            disabled={!revealRoute}
          >
            Reveal in Files
          </button>
          <button type="button" onClick={copyDirectLink} disabled={!directLink}>
            Copy preview link
          </button>
          <button
            type="button"
            onClick={
              attachedToConversation
                ? removeFromConversation
                : addToConversation
            }
            disabled={
              !intent ||
              (!attachedToConversation && query.data?.status !== 'ready')
            }
          >
            {attachedToConversation
              ? 'Remove from conversation'
              : 'Add to conversation'}
          </button>
        </div>
        {contextNotice && <p role="status">{contextNotice}</p>}
      </div>
      <div
        ref={performanceSurfaceRef}
        data-station-performance-surface="workspace-file-preview"
        data-station-project-slug={state.projectSlug}
        data-station-file-path={state.path}
        style={{
          flex: 1,
          maxHeight: '60vh',
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
          requestAnimationFrame(() => {
            surface.getBoundingClientRect();
            emitFilePreviewScrollPerformanceMark({
              projectSlug: state.projectSlug,
              path: state.path,
              scrollTop: surface.scrollTop,
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
        ) : query.data ? (
          <PreviewContent
            preview={query.data}
            state={state}
            stateKey={stateKey}
          />
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
