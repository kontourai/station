import type { PullRequestReviewComment } from '@kontourai/station-contracts/pull-request-provider';
import {
  type DiffComment,
  useCodingDiffQuery,
  useCreateDiffCommentMutation,
  useDeleteDiffCommentMutation,
  useDiffCommentsQuery,
} from '@kontourai/station-sdk';
import {
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
} from '@pierre/diffs/react';
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
import { createPortal } from 'react-dom';
import {
  browserEpochMs,
  emitDiffCommitPerformanceMark,
} from '../../performance/interactive-workspace-performance-hooks';
import { usePaneHeadSlots } from '../../workspace-panes/PaneHeadSlots';
import { SkeletonBlock } from '../state';
import {
  CollapseAllGlyph,
  ColumnsGlyph,
  ExpandAllGlyph,
  WrapGlyph,
} from './diffGlyphs';

type DiffCommentSide = DiffComment['side'];

/**
 * @pierre/diffs draws its own `-N +N` before the header's metadata slot, and
 * has no option to leave it out short of replacing the whole header. Station
 * draws the file's counts in that slot itself (`renderHeaderMetadata`,
 * additions first like the pane's total, and a kind for a hunkless file), so
 * the library's pair is hidden through its own stylesheet hook, which reaches
 * into the diff's shadow root where a page rule cannot.
 */
const LIBRARY_FILE_COUNTS_HIDDEN =
  '[data-metadata] > [data-additions-count], [data-metadata] > [data-deletions-count] { display: none; }';

/** Metadata carried on each annotated diff line: its comments + composer flag. */
interface DiffCommentAnnotation {
  comments: DiffComment[];
  composing: boolean;
  /** Read-only comments the forge anchored to this line. */
  provider?: PullRequestReviewComment[];
}

/** A forge's inline comments on one diff line, read-only. */
function ProviderCommentThread({
  comments,
}: {
  comments: PullRequestReviewComment[];
}) {
  return (
    <div className="diff-comment-thread diff-comment-thread--provider">
      {comments.map((comment) => (
        <div
          key={comment.id}
          className="diff-comment"
          data-provider-comment={comment.id}
        >
          <div className="diff-comment__meta">
            <strong>{comment.author || 'Unknown author'}</strong>
            <span className="diff-comment__time">
              {Number.isNaN(Date.parse(comment.createdAt))
                ? ''
                : new Date(comment.createdAt).toLocaleString()}
            </span>
          </div>
          <div className="diff-comment__body">{comment.body}</div>
        </div>
      ))}
    </div>
  );
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
 * the raw patch text using the library's file boundaries and parsed names.
 * This keeps quoted and renamed paths aligned with the metadata CodeView uses.
 */
function binaryFileNames(patch: string): Set<string> {
  const names = new Set<string>();
  for (const block of patch.split(GIT_DIFF_FILE_BREAK_REGEX)) {
    if (!/^Binary files /m.test(block)) continue;
    for (const file of parseDiffFiles(block)) {
      names.add(file.name);
      if (file.prevName) names.add(file.prevName);
    }
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

interface DiffChangeCounts {
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
function diffFileChangeCounts(fileDiff: FileDiffMetadata): DiffChangeCounts {
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
type DiffFileKind = 'lines' | 'renamed' | 'binary' | 'unknown';

function diffFileKind(
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
function diffTotalChangeCounts(files: FileDiffMetadata[]): DiffChangeCounts {
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
  /** The Project the diff is read in (#2412: the server refuses a folder
   * outside it). */
  projectSlug: string;
}) {
  const { apiBase } = useApiBase();
  const {
    data: diff = '',
    isLoading: loading,
    error: queryError,
    refetch,
  } = useCodingDiffQuery({ projectSlug, workingDir }, apiBase);
  return (
    <ObservedDiffPanel
      diff={diff}
      loading={loading}
      error={queryError?.message || null}
      onRetry={() => void refetch()}
      observationKey={workingDir}
      projectSlug={projectSlug}
    />
  );
}

/** Render supplied, already observed diff bytes without reading the checkout. */
export function ObservedDiffPanel({
  diff,
  loading = false,
  error = null,
  onRetry,
  observationKey,
  projectSlug,
  providerComments,
}: {
  diff: string;
  loading?: boolean;
  error?: string | null;
  /** Re-read after an error; the error line offers it when given. */
  onRetry?: () => void;
  observationKey: string;
  projectSlug?: string;
  /**
   * A forge's inline review comments to show read-only on their lines. Only
   * comments with a line are placed; the caller lists the rest.
   */
  providerComments?: readonly PullRequestReviewComment[];
}) {
  const performanceSurfaceRef = useRef<HTMLDivElement | null>(null);

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

  // @pierre/diffs returns before mounting hunks while its worker pool is
  // initializing. A worker that constructs successfully but never becomes
  // ready (for example after a worker-script load failure) therefore leaves
  // the custom element with only its SVG sprite indefinitely. The library
  // exposes no readiness/error fallback at the React seam, so render on its
  // reliable main-thread path and warm the shared highlighter for the active
  // theme. Correct diff and comment-gutter rendering takes precedence over
  // off-main-thread tokenization; large files remain bounded by CodeView's
  // existing virtualization and tokenizeMaxLineLength option.
  useEffect(() => {
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
      workingDir: observationKey,
      patchBytes: new TextEncoder().encode(diff).byteLength,
      fileCount: files.length,
      committedEpochMs: browserEpochMs(),
    });
  }, [collapseOverrides, diff, error, files.length, loading, observationKey]);
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

  const providerByFile = useMemo(() => {
    const byFile = new Map<string, Map<string, PullRequestReviewComment[]>>();
    for (const comment of providerComments ?? []) {
      if (comment.line === null) continue;
      const lines = byFile.get(comment.path) ?? new Map();
      const key = sideLineKey(comment.side, comment.line);
      lines.set(key, [...(lines.get(key) ?? []), comment]);
      byFile.set(comment.path, lines);
    }
    return byFile;
  }, [providerComments]);

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
      const forgeComments = providerByFile.get(filePath);
      // Annotate every line that has comments, plus the active composer line.
      const keys = new Set<string>([
        ...(lineComments ? lineComments.keys() : []),
        ...(forgeComments ? forgeComments.keys() : []),
      ]);
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
            ...(forgeComments?.has(key)
              ? { provider: forgeComments.get(key) }
              : {}),
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
  }, [
    files,
    commentsByFile,
    providerByFile,
    composer,
    collapseOverrides,
    fileCounts,
  ]);

  const fileOf = (item: CodeViewItem<DiffCommentAnnotation>): string =>
    item.type === 'diff' ? item.fileDiff.name : '';

  const renderAnnotation = (
    annotation: DiffLineAnnotation<DiffCommentAnnotation>,
    item: CodeViewItem<DiffCommentAnnotation>,
  ): ReactNode => {
    const filePath = fileOf(item);
    const meta = annotation.metadata;
    if (!meta) return null;
    if (!commentsEnabled)
      return meta.provider ? (
        <ProviderCommentThread comments={meta.provider} />
      ) : null;
    return (
      <>
        {meta.provider && <ProviderCommentThread comments={meta.provider} />}
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
      </>
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
      // Remount so the main-thread renderer re-tokenizes for the new theme.
      key={diffTheme}
      disableWorkerPool
      items={items}
      renderAnnotation={
        commentsEnabled || providerByFile.size > 0
          ? renderAnnotation
          : undefined
      }
      renderGutterUtility={commentsEnabled ? renderGutterUtility : undefined}
      renderHeaderPrefix={renderHeaderPrefix}
      renderHeaderMetadata={renderHeaderMetadata}
      options={{
        theme: diffTheme,
        themeType: theme,
        diffStyle,
        lineDiffType: 'none',
        overflow: wrap ? 'wrap' : 'scroll',
        unsafeCSS: LIBRARY_FILE_COUNTS_HIDDEN,
      }}
    />
  );

  // The counts and the four icon tools, drawn in one of two places. Inside a
  // host that draws the pane's head itself (the Coding layout's side panel,
  // #3046 round), the head names the pane: the counts join it after the
  // name and the tools before the host's close, and the pane draws no row of
  // its own. On its own, the pane draws them as one quiet row. Either way
  // the tools are icon-only, named and tipped; the two toggles say which way
  // they are set (`aria-pressed`). The host keeps its own ⋯ (pop out,
  // remove): the pane has no overflow to merge it into.
  const headSlots = usePaneHeadSlots();
  const stats = (
    <span className="diff-stat">
      <span className="diff-stat__files">
        {files.length} {files.length === 1 ? 'file' : 'files'}
      </span>
      <span className="diff-stat__additions">+{totalCounts.additions}</span>
      <span className="diff-stat__deletions">−{totalCounts.deletions}</span>
    </span>
  );
  const renderTools = (placement: 'head' | 'bar') => (
    <div
      className={`diff-panel__tools${placement === 'head' ? ' diff-panel__tools--head' : ''}`}
    >
      <button
        type="button"
        onClick={collapseAllFiles}
        title="Collapse all files"
        aria-label="Collapse all files"
        className="diff-tool"
      >
        <CollapseAllGlyph />
      </button>
      <button
        type="button"
        onClick={expandAllFiles}
        title="Expand all files"
        aria-label="Expand all files"
        className="diff-tool"
      >
        <ExpandAllGlyph />
      </button>
      <button
        type="button"
        onClick={() =>
          setDiffStyle(diffStyle === 'unified' ? 'split' : 'unified')
        }
        title="Split view"
        aria-label="Split view"
        aria-pressed={diffStyle === 'split'}
        className="diff-tool"
      >
        <ColumnsGlyph />
      </button>
      <button
        type="button"
        onClick={() => setWrap(!wrap)}
        title="Wrap lines"
        aria-label="Wrap lines"
        aria-pressed={wrap}
        className="diff-tool"
      >
        <WrapGlyph />
      </button>
    </div>
  );

  return (
    <div
      ref={performanceSurfaceRef}
      className="diff-panel"
      data-station-performance-surface="worktree-diff"
    >
      {headSlots ? (
        <>
          {headSlots.leading && hasDiff
            ? createPortal(stats, headSlots.leading)
            : null}
          {headSlots.trailing && hasDiff
            ? createPortal(renderTools('head'), headSlots.trailing)
            : null}
        </>
      ) : (
        hasDiff && (
          <div className="diff-panel__bar">
            {stats}
            {renderTools('bar')}
          </div>
        )
      )}
      <div className="diff-panel__body">
        {loading && <SkeletonBlock count={2} label="Loading diff" />}
        {error && (
          <p className="diff-panel__note diff-panel__note--error" role="alert">
            {error}
            {onRetry && (
              <>
                {' '}
                <button
                  type="button"
                  className="button button--link"
                  onClick={onRetry}
                >
                  Retry
                </button>
              </>
            )}
          </p>
        )}
        {hasDiff && codeView}
        {!loading && !error && !hasDiff && (
          <p className="diff-panel__note">
            {hasPatchText ? 'Unable to parse diff.' : 'No changes'}
          </p>
        )}
      </div>
    </div>
  );
}
