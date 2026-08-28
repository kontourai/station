import {
  type DiffComment,
  useCodingDiffQuery,
  useCreateDiffCommentMutation,
  useDeleteDiffCommentMutation,
  useDiffCommentsQuery,
} from '@kontourai/station-sdk';
import {
  ALTERNATE_FILE_NAMES_GIT,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  GIT_DIFF_FILE_BREAK_REGEX,
  parsePatchFiles,
  preloadHighlighter,
} from '@pierre/diffs';
import {
  CodeView,
  type CodeViewDiffItem,
  type CodeViewItem,
  useWorkerPool,
  WorkerPoolContextProvider,
} from '@pierre/diffs/react';
// Vite (the UI bundler) compiles `?worker` to a Worker constructor. The pool
// parses diffs + runs Shiki tokenization off the main thread so large diffs
// don't jank the UI.
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../../contexts/DeviceSettingsContext';
import { DiffCommentThread } from './DiffCommentThread';
import './DiffPanel.css';
import {
  browserEpochMs,
  emitDiffCommitPerformanceMark,
} from '../../performance/interactive-workspace-performance-hooks';
import { SkeletonBlock } from '../state';

type DiffCommentSide = DiffComment['side'];

/** Metadata carried on each annotated diff line: its comments + composer flag. */
interface DiffCommentAnnotation {
  comments: DiffComment[];
  composing: boolean;
}

interface ActiveComposer {
  filePath: string;
  side: DiffCommentSide;
  lineNumber: number;
}

const sideLineKey = (side: DiffCommentSide, lineNumber: number) =>
  `${side}:${lineNumber}`;

// Map Station's light/dark theme (stored on <html data-theme> by ThemeToggle)
// to the diff themes registered by @pierre/diffs.
const DIFF_THEME_NAMES = {
  light: 'pierre-light',
  dark: 'pierre-dark',
} as const;

type StationTheme = 'light' | 'dark';

// Workers exist in the browser but not in jsdom (unit tests) or SSR; fall back
// to main-thread rendering there.
const WORKER_SUPPORTED = typeof Worker !== 'undefined';

function readStationTheme(): StationTheme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light'
    ? 'light'
    : 'dark';
}

/**
 * Tracks Station's current theme. ThemeToggle writes `data-theme` on the
 * document element, so we mirror that and re-read whenever it changes.
 */
function useStationTheme(): StationTheme {
  const [theme, setTheme] = useState<StationTheme>(readStationTheme);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const target = document.documentElement;
    const observer = new MutationObserver(() => setTheme(readStationTheme()));
    observer.observe(target, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    // Sync once in case the attribute changed before the observer attached.
    setTheme(readStationTheme());
    return () => observer.disconnect();
  }, []);

  return theme;
}

function diffWorkerPoolSize(): number {
  const cores =
    typeof navigator === 'undefined'
      ? 4
      : Math.max(1, navigator.hardwareConcurrency || 4);
  return Math.max(2, Math.min(6, Math.floor(cores / 2)));
}

/** Keeps the worker pool's render theme in sync with Station's theme. */
function DiffWorkerThemeSync({ themeName }: { themeName: string }) {
  const workerPool = useWorkerPool();
  useEffect(() => {
    if (!workerPool) return;
    void (async () => {
      try {
        const current = workerPool.getDiffRenderOptions();
        if (current.theme === themeName) return;
        await workerPool.setRenderOptions({ ...current, theme: themeName });
      } catch {
        // Theme sync is best-effort; the diff still renders.
      }
    })();
  }, [themeName, workerPool]);
  return null;
}

function DiffWorkerPoolProvider({
  themeName,
  children,
}: {
  themeName: string;
  children?: ReactNode;
}) {
  const poolSize = useMemo(diffWorkerPoolSize, []);
  return (
    <WorkerPoolContextProvider
      poolOptions={{
        workerFactory: () => new DiffsWorker(),
        poolSize,
        totalASTLRUCacheSize: 240,
      }}
      highlighterOptions={{
        theme: themeName,
        tokenizeMaxLineLength: 1_000,
        useTokenTransformer: true,
      }}
    >
      <DiffWorkerThemeSync themeName={themeName} />
      {children}
    </WorkerPoolContextProvider>
  );
}

/**
 * Parse a unified-diff/patch string into per-file diff metadata that CodeView
 * can render. Returns an empty array when the patch is empty or unparseable.
 */
function parseDiffFiles(patch: string): FileDiffMetadata[] {
  const normalized = patch.trim();
  if (normalized.length === 0) return [];
  try {
    return parsePatchFiles(normalized, 'coding-diff-panel').flatMap(
      (parsed) => parsed.files,
    );
  } catch {
    return [];
  }
}

/**
 * archive#3170. `FileDiffMetadata` has no `binary` field — @pierre/diffs'
 * patch parser never recognizes git's `Binary files a/x and b/x differ`
 * marker line, so a binary file parses with an empty `hunks` array and
 * whatever `type` its other header lines implied (typically `change`),
 * indistinguishable from an empty text file. This recovers that fact from
 * the raw patch text using the SAME per-file split and header-name regexes
 * `parsePatchFiles` itself uses internally (`GIT_DIFF_FILE_BREAK_REGEX`,
 * `ALTERNATE_FILE_NAMES_GIT`, both public exports) — not a hand-rolled diff
 * parser, so it can't drift from what the real parser considers a file
 * boundary or a file name.
 */
export function binaryFileNames(patch: string): Set<string> {
  const names = new Set<string>();
  for (const block of patch.split(GIT_DIFF_FILE_BREAK_REGEX)) {
    if (!/^Binary files /m.test(block)) continue;
    const header = block.match(/^diff --git .*$/m)?.[0];
    const match = header ? ALTERNATE_FILE_NAMES_GIT.exec(header) : null;
    if (!match) continue;
    const oldName = match[1] ?? match[2];
    const newName = match[3] ?? match[4];
    if (oldName) names.add(oldName);
    if (newName) names.add(newName);
  }
  return names;
}

/**
 * Stable identity for a parsed file diff, matching what CodeView needs for
 * its `CodeViewDiffItem.id`. Shared by the items list, the per-file counts
 * map, and collapse-state lookups so all three agree on the same key for the
 * same file.
 */
function diffItemId(fileDiff: FileDiffMetadata, index: number): string {
  return (
    fileDiff.cacheKey ??
    `${fileDiff.prevName ?? 'none'}:${fileDiff.name}:${index}`
  );
}

export interface DiffChangeCounts {
  additions: number;
  deletions: number;
}

/**
 * Added/removed line counts for one file, derived from @pierre/diffs' own
 * parsed hunk structure — the `ChangeContent` blocks inside each `Hunk`,
 * which are exactly what CodeView renders as `+`/`-` lines. This walks the
 * same `FileDiffMetadata` the panel hands to CodeView, so it can't disagree
 * with what's on screen; it deliberately does not re-count lines from the
 * raw patch text (a second, independently-fallible source of truth).
 */
export function diffFileChangeCounts(
  fileDiff: FileDiffMetadata,
): DiffChangeCounts {
  let additions = 0;
  let deletions = 0;
  for (const hunk of fileDiff.hunks) {
    for (const block of hunk.hunkContent) {
      if (block.type === 'change') {
        additions += block.additions;
        deletions += block.deletions;
      }
    }
  }
  return { additions, deletions };
}

/**
 * archive#3170. `diffFileChangeCounts` sums line-level hunk content, which
 * is `0`/`0` for any file with zero hunks — a pure rename or a binary file,
 * neither of which has hunk-shaped content to sum. `+0 −0` is a correct line
 * count and a misleading summary: it reads as "nothing changed" for a file
 * that did. This names what actually happened for a hunkless file so the
 * header can render that instead of a zero. Files with hunks (`'lines'`)
 * are unaffected — the numeric stat still renders exactly as before.
 */
export type DiffFileKind = 'lines' | 'renamed' | 'binary' | 'unknown';

export function diffFileKind(
  fileDiff: FileDiffMetadata,
  isBinary: boolean,
): DiffFileKind {
  if (fileDiff.hunks.length > 0) return 'lines';
  if (isBinary) return 'binary';
  if (fileDiff.type === 'rename-pure') return 'renamed';
  // A hunkless, non-binary, non-renamed file — e.g. a newly-added empty
  // file, or a pure file-mode change. No line count applies and it isn't a
  // rename or binary, so say so rather than implying "no change" with 0/0.
  return 'unknown';
}

const DIFF_FILE_KIND_LABEL: Record<Exclude<DiffFileKind, 'lines'>, string> = {
  renamed: 'renamed',
  binary: 'binary',
  unknown: '—',
};

/** Sum of `diffFileChangeCounts` across every file in the diff. */
export function diffTotalChangeCounts(
  files: FileDiffMetadata[],
): DiffChangeCounts {
  let additions = 0;
  let deletions = 0;
  for (const fileDiff of files) {
    const counts = diffFileChangeCounts(fileDiff);
    additions += counts.additions;
    deletions += counts.deletions;
  }
  return { additions, deletions };
}

/**
 * A file whose total changed lines (additions + deletions) exceed this is
 * collapsed by default (archive#3104) — keeps a many-file agent turn
 * skimmable without scrolling through every hunk. Counts still render on a
 * collapsed file (see `renderHeaderMetadata` below), so collapsing never
 * hides that a big change exists.
 */
export const LARGE_DIFF_COLLAPSE_THRESHOLD = 300;

function isLargeDiffChange(counts: DiffChangeCounts): boolean {
  return counts.additions + counts.deletions > LARGE_DIFF_COLLAPSE_THRESHOLD;
}

export function DiffPanel({
  workingDir,
  projectSlug,
}: {
  workingDir: string;
  projectSlug?: string;
}) {
  const performanceSurfaceRef = useRef<HTMLDivElement | null>(null);
  const { apiBase } = useApiBase();
  const {
    data: diff = '',
    isLoading: loading,
    error: queryError,
  } = useCodingDiffQuery(workingDir, apiBase);
  const error = queryError?.message || null;

  // Inline review comments are only available when a project owns the diff.
  const commentsEnabled = !!projectSlug;
  const { data: comments = [] } = useDiffCommentsQuery(projectSlug, {
    enabled: commentsEnabled,
  });
  const createComment = useCreateDiffCommentMutation(projectSlug ?? '');
  const deleteComment = useDeleteDiffCommentMutation(projectSlug ?? '');
  const [composer, setComposer] = useState<ActiveComposer | null>(null);

  const theme = useStationTheme();
  const diffTheme = DIFF_THEME_NAMES[theme];

  // Sticky view preferences, persisted via the device-settings store
  // (archive#settings-revamp — previously their own raw
  // `station.diff.style`/`station.diff.wrap` localStorage keys).
  const { diffStyle, diffWrap: wrap } = useDeviceSettings();
  const { setDeviceSetting } = useDeviceSettingsActions();
  const setDiffStyle = useCallback(
    (value: 'unified' | 'split') => setDeviceSetting('diffStyle', value),
    [setDeviceSetting],
  );
  const setWrap = useCallback(
    (value: boolean) => setDeviceSetting('diffWrap', value),
    [setDeviceSetting],
  );

  // On the main-thread fallback (no worker) the shared highlighter must be
  // warmed for the active theme; the worker pool warms its own highlighter.
  useEffect(() => {
    if (WORKER_SUPPORTED) return;
    void preloadHighlighter({ themes: [diffTheme], langs: [] }).catch(() => {
      // Highlighter preload is best-effort; CodeView still renders plain text.
    });
  }, [diffTheme]);

  const files = useMemo(() => parseDiffFiles(diff), [diff]);

  // archive#3170 — file names @pierre/diffs' parser drops when a file is
  // binary (see `binaryFileNames`'s docblock).
  const binaryNames = useMemo(() => binaryFileNames(diff), [diff]);

  // Per-file addition/deletion counts, keyed by the same id CodeView items
  // use. Derived straight from the parsed hunks (see `diffFileChangeCounts`)
  // never a separate scan of the raw patch text.
  const fileCounts = useMemo(() => {
    const map = new Map<string, DiffChangeCounts>();
    files.forEach((fileDiff, index) => {
      map.set(diffItemId(fileDiff, index), diffFileChangeCounts(fileDiff));
    });
    return map;
  }, [files]);
  // Per-file kind (archive#3170) — whether a hunkless file's header should
  // read "renamed"/"binary" instead of a misleading "+0 −0".
  const fileKinds = useMemo(() => {
    const map = new Map<string, DiffFileKind>();
    files.forEach((fileDiff, index) => {
      const isBinary =
        binaryNames.has(fileDiff.name) ||
        (fileDiff.prevName != null && binaryNames.has(fileDiff.prevName));
      map.set(diffItemId(fileDiff, index), diffFileKind(fileDiff, isBinary));
    });
    return map;
  }, [files, binaryNames]);
  const totalCounts = useMemo(() => diffTotalChangeCounts(files), [files]);
  // Per-file collapse choices (manual toggles + collapse/expand-all)
  // deliberately live in component state rather than the device-settings
  // store diffStyle/diffWrap use. That store holds durable, low-cardinality
  // view preferences; collapse state is keyed by per-file identity that only
  // exists for the lifetime of the diff currently on screen — the file set
  // (and even the file count) changes on every agent turn. Persisting it
  // would mean growing an unbounded keyed store and replaying stale
  // per-file choices onto an unrelated diff next time this panel opens.
  // React state already satisfies the "survives a re-render" requirement.
  const [collapseOverrides, setCollapseOverrides] = useState<
    Map<string, boolean>
  >(() => new Map());
  // Collapse/expand is itself a rendered diff-surface commit even though the
  // content-free receipt below does not inspect the override map.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only dependency described above.
  useLayoutEffect(() => {
    if (
      import.meta.env.MODE !== 'test' &&
      import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE !== '1'
    )
      return;
    if (loading || error || !performanceSurfaceRef.current) return;
    performanceSurfaceRef.current.getBoundingClientRect();
    emitDiffCommitPerformanceMark({
      workingDir,
      patchBytes: new TextEncoder().encode(diff).byteLength,
      fileCount: files.length,
      committedEpochMs: browserEpochMs(),
    });
  }, [collapseOverrides, diff, error, files.length, loading, workingDir]);
  // A freshly loaded diff starts from the size-based default, not whatever
  // per-file choices were made on the previous diff. `diff` is the
  // intentional reset trigger even though the effect body doesn't read it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above.
  useEffect(() => {
    setCollapseOverrides(new Map());
  }, [diff]);

  const toggleFileCollapsed = useCallback(
    (id: string, currentlyCollapsed: boolean) => {
      setCollapseOverrides((prev) => {
        const next = new Map(prev);
        next.set(id, !currentlyCollapsed);
        return next;
      });
    },
    [],
  );
  const collapseAllFiles = useCallback(() => {
    setCollapseOverrides(() => {
      const next = new Map<string, boolean>();
      files.forEach((fileDiff, index) =>
        next.set(diffItemId(fileDiff, index), true),
      );
      return next;
    });
  }, [files]);
  const expandAllFiles = useCallback(() => {
    setCollapseOverrides(() => {
      const next = new Map<string, boolean>();
      files.forEach((fileDiff, index) =>
        next.set(diffItemId(fileDiff, index), false),
      );
      return next;
    });
  }, [files]);

  // Comments grouped by file → "side:line" → comments, for O(1) annotation lookup.
  const commentsByFile = useMemo(() => {
    const byFile = new Map<string, Map<string, DiffComment[]>>();
    for (const comment of comments) {
      const lines = byFile.get(comment.filePath) ?? new Map();
      const key = sideLineKey(comment.side, comment.lineNumber);
      lines.set(key, [...(lines.get(key) ?? []), comment]);
      byFile.set(comment.filePath, lines);
    }
    return byFile;
  }, [comments]);

  // @pierre/diffs' controlled CodeView only refreshes an item's internal
  // record — including re-invoking renderHeaderPrefix/renderHeaderMetadata —
  // when `item.version` changes (components/CodeView.js's `syncItemRecord`:
  // "Matching versions mean CodeView keeps the current record snapshot").
  // Passing a fresh object with the same id/version is otherwise silently
  // ignored, which would leave the collapse toggle's header content
  // permanently stale after the first click. Bump a shared counter on every
  // genuine `items` recompute so CodeView always treats a real update
  // (collapse toggle, new comment annotation) as a version change.
  const itemsRevisionRef = useRef(0);

  const items = useMemo<CodeViewDiffItem<DiffCommentAnnotation>[]>(() => {
    itemsRevisionRef.current += 1;
    const version = itemsRevisionRef.current;
    return files.map((fileDiff, index) => {
      const id = diffItemId(fileDiff, index);
      const filePath = fileDiff.name;
      const lineComments = commentsByFile.get(filePath);
      // Annotate every line that has comments, plus the active composer line.
      const keys = new Set<string>(lineComments ? lineComments.keys() : []);
      if (composer && composer.filePath === filePath) {
        keys.add(sideLineKey(composer.side, composer.lineNumber));
      }
      const annotations: DiffLineAnnotation<DiffCommentAnnotation>[] = [
        ...keys,
      ].map((key) => {
        const [side, lineStr] = key.split(':');
        const lineNumber = Number(lineStr);
        const lineSide = side as DiffCommentSide;
        return {
          side: lineSide,
          lineNumber,
          metadata: {
            comments: lineComments?.get(key) ?? [],
            composing:
              !!composer &&
              composer.filePath === filePath &&
              composer.side === lineSide &&
              composer.lineNumber === lineNumber,
          },
        };
      });
      const override = collapseOverrides.get(id);
      const counts = fileCounts.get(id);
      const collapsed =
        override ?? (counts != null && isLargeDiffChange(counts));
      return {
        id,
        type: 'diff',
        fileDiff,
        collapsed,
        version,
        ...(annotations.length > 0 ? { annotations } : {}),
      };
    });
  }, [files, commentsByFile, composer, collapseOverrides, fileCounts]);

  const fileOf = (item: CodeViewItem<DiffCommentAnnotation>): string =>
    item.type === 'diff' ? item.fileDiff.name : '';

  const renderAnnotation = (
    annotation: DiffLineAnnotation<DiffCommentAnnotation>,
    item: CodeViewItem<DiffCommentAnnotation>,
  ): ReactNode => {
    const filePath = fileOf(item);
    const meta = annotation.metadata;
    if (!meta) return null;
    return (
      <DiffCommentThread
        comments={meta.comments}
        composing={meta.composing}
        busy={createComment.isPending}
        onSubmit={(body) =>
          createComment.mutate(
            {
              filePath,
              side: annotation.side,
              lineNumber: annotation.lineNumber,
              body,
            },
            { onSuccess: () => setComposer(null) },
          )
        }
        onCancel={() => setComposer(null)}
        onStartReply={() =>
          setComposer({
            filePath,
            side: annotation.side,
            lineNumber: annotation.lineNumber,
          })
        }
        onDelete={(id) => deleteComment.mutate(id)}
      />
    );
  };

  const renderGutterUtility = (
    getHoveredLine: () =>
      | { lineNumber: number; side?: DiffCommentSide }
      | undefined,
    item: CodeViewItem<DiffCommentAnnotation>,
  ): ReactNode => {
    const filePath = fileOf(item);
    return (
      <button
        type="button"
        className="diff-comment-add"
        title="Add comment on this line"
        aria-label="Add comment on this line"
        onClick={(e) => {
          e.stopPropagation();
          const hovered = getHoveredLine();
          if (hovered?.side) {
            setComposer({
              filePath,
              side: hovered.side,
              lineNumber: hovered.lineNumber,
            });
          }
        }}
      >
        +
      </button>
    );
  };

  // Per-file collapse/expand affordance, rendered into @pierre/diffs'
  // `header-prefix` slot (a real light-DOM element, not shadow content — see
  // renderDiffChildren in @pierre/diffs' react layer), so it's a normal,
  // keyboard-reachable <button> like the existing gutter "add comment"
  // control above. Collapsing a file only hides its rendered lines
  // (@pierre/diffs still renders the file header when `collapsed` is set,
  // see components/FileDiff.js's `shouldRenderHeader`), so the counts in
  // renderHeaderMetadata below stay visible either way.
  const renderHeaderPrefix = useCallback(
    (item: CodeViewItem<DiffCommentAnnotation>): ReactNode => {
      if (item.type !== 'diff') return null;
      const collapsed = item.collapsed === true;
      return (
        <button
          type="button"
          className="diff-file-collapse-toggle"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${item.fileDiff.name}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleFileCollapsed(item.id, collapsed);
          }}
        >
          <span aria-hidden="true" className="diff-file-collapse-toggle__icon">
            ▾
          </span>
        </button>
      );
    },
    [toggleFileCollapsed],
  );

  // Per-file addition/deletion counts, rendered into the `header-metadata`
  // slot next to the filename — visible whether or not the file is
  // collapsed, and whether or not anything is ever expanded at all.
  const renderHeaderMetadata = useCallback(
    (item: CodeViewItem<DiffCommentAnnotation>): ReactNode => {
      if (item.type !== 'diff') return null;
      const counts = fileCounts.get(item.id);
      if (!counts) return null;
      const kind = fileKinds.get(item.id) ?? 'lines';
      // archive#3170 — a hunkless file (rename or binary) has no line
      // counts to sum, so `+0 −0` would read as "nothing changed" for a
      // file that did. Render what kind of hunkless change it was instead.
      if (kind !== 'lines') {
        return (
          <span className="diff-file-stat diff-file-stat--kind">
            {DIFF_FILE_KIND_LABEL[kind]}
          </span>
        );
      }
      return (
        <span className="diff-file-stat">
          <span className="diff-file-stat__additions">+{counts.additions}</span>
          <span className="diff-file-stat__deletions">−{counts.deletions}</span>
        </span>
      );
    },
    [fileCounts, fileKinds],
  );

  const hasDiff = !loading && !error && items.length > 0;
  const hasPatchText = diff.trim().length > 0;

  const codeView = (
    <CodeView<DiffCommentAnnotation>
      // The fallback re-tokenizes on theme change via remount; the worker pool
      // re-themes in place (see DiffWorkerThemeSync), so no key is needed there.
      key={WORKER_SUPPORTED ? undefined : diffTheme}
      disableWorkerPool={!WORKER_SUPPORTED}
      items={items}
      renderAnnotation={commentsEnabled ? renderAnnotation : undefined}
      renderGutterUtility={commentsEnabled ? renderGutterUtility : undefined}
      renderHeaderPrefix={renderHeaderPrefix}
      renderHeaderMetadata={renderHeaderMetadata}
      options={{
        theme: diffTheme,
        themeType: theme,
        diffStyle,
        lineDiffType: 'none',
        overflow: wrap ? 'wrap' : 'scroll',
      }}
    />
  );

  return (
    <div
      ref={performanceSurfaceRef}
      data-station-performance-surface="worktree-diff"
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          padding: '6px 12px 4px',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: '11px',
            fontWeight: 600,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          Git Diff
        </span>
        {hasDiff && (
          <span className="diff-stat">
            <span className="diff-stat__files">
              {files.length} {files.length === 1 ? 'file' : 'files'}
            </span>
            <span className="diff-stat__additions">
              +{totalCounts.additions}
            </span>
            <span className="diff-stat__deletions">
              −{totalCounts.deletions}
            </span>
          </span>
        )}
        {hasDiff && (
          <div style={{ display: 'flex', gap: '4px' }}>
            <button
              type="button"
              onClick={collapseAllFiles}
              title="Collapse all files"
              aria-label="Collapse all files"
              className="diff-toggle"
            >
              Collapse all
            </button>
            <button
              type="button"
              onClick={expandAllFiles}
              title="Expand all files"
              aria-label="Expand all files"
              className="diff-toggle"
            >
              Expand all
            </button>
            <button
              type="button"
              onClick={() =>
                setDiffStyle(diffStyle === 'unified' ? 'split' : 'unified')
              }
              title={`Switch to ${diffStyle === 'unified' ? 'split' : 'unified'} view`}
              aria-label={`Diff view: ${diffStyle} (click to switch)`}
              className="diff-toggle"
            >
              {diffStyle === 'unified' ? 'Unified' : 'Split'}
            </button>
            <button
              type="button"
              onClick={() => setWrap(!wrap)}
              title={wrap ? 'Disable line wrap' : 'Enable line wrap'}
              aria-pressed={wrap}
              aria-label="Toggle line wrap"
              className={
                wrap ? 'diff-toggle diff-toggle--active' : 'diff-toggle'
              }
            >
              Wrap
            </button>
          </div>
        )}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 12px 12px' }}>
        {loading && <SkeletonBlock count={2} label="Loading diff" />}
        {error && (
          <div style={{ fontSize: '12px', color: 'var(--error-text)' }}>
            {error}
          </div>
        )}
        {hasDiff &&
          (WORKER_SUPPORTED ? (
            <DiffWorkerPoolProvider themeName={diffTheme}>
              {codeView}
            </DiffWorkerPoolProvider>
          ) : (
            codeView
          ))}
        {!loading && !error && !hasDiff && (
          <div
            style={{
              padding: '12px',
              fontSize: '12px',
              color: 'var(--text-muted)',
            }}
          >
            {hasPatchText ? 'Unable to parse diff.' : 'No changes'}
          </div>
        )}
      </div>
    </div>
  );
}
