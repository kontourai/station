import {
  normalizeTaskReviewText,
  parseTaskReviewAnchor,
  relocateTextQuote,
  type TaskReviewAnchor,
  type TaskReviewArtifactRef,
  type TaskReviewThreadView,
} from '@kontourai/station-contracts/task-review';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Options } from 'react-markdown';
import { Button } from '../../../components/Button';
import { MarkdownRenderer } from '../../../components/chat/MarkdownRenderer';
import {
  CheckGlyph,
  CloseGlyph,
  DocumentGlyph,
  MessageGlyph,
} from '../../../components/icons/Glyph';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { ReviewAnchorComposer } from './ReviewAnchorComposer';

interface SourceNode {
  type: string;
  value?: string;
  position?: {
    start: { offset?: number; line?: number };
    end: { offset?: number; line?: number };
  };
  children?: SourceNode[];
  tagName?: string;
  properties?: Record<string, unknown>;
}
type Bounds = { start: number; end: number };
type Character = [number, number];

// HAST code and path-mention text may only retain their parent's position.
// Map every displayed character; an unmappable leaf stays unmarked.
function mapCharacters(
  text: string,
  value: string,
  bounds: Bounds,
  code: boolean,
): Character[] | null {
  let source = bounds.start;
  const raw = text.slice(source, bounds.end);
  if (code && /^(`{3,}|~{3,})/.test(raw)) source += raw.indexOf('\n') + 1;
  else if (code && raw.startsWith('`')) source += raw.match(/^`+/)![0].length;
  const mapped: Character[] = [];
  for (let display = 0; display < value.length; ) {
    const entity = text
      .slice(source, bounds.end)
      .match(/^&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/i)?.[0];
    if (entity) {
      const decoder = document.createElement('textarea');
      decoder.innerHTML = entity;
      if (
        decoder.value !== entity &&
        value.startsWith(decoder.value, display)
      ) {
        for (let i = 0; i < decoder.value.length; i++)
          mapped.push([source, source + entity.length]);
        source += entity.length;
        display += decoder.value.length;
        continue;
      }
    }
    if (text[source] === '\\' && text[source + 1] === value[display]) source++;
    if (text[source] === value[display] && source < bounds.end) {
      mapped.push([source, source + 1]);
      source++;
      display++;
      continue;
    }
    // Container prefixes and inline delimiters are absent from rendered text.
    // Never skip arbitrary prose to manufacture a mapping.
    if (source < bounds.end && /[\s>*_`~#[\]]/.test(text[source])) {
      source++;
      continue;
    }
    // mdast adds a final newline to a fenced code value.
    if (code && display === value.length - 1 && value[display] === '\n') break;
    return null;
  }
  return mapped.length ? mapped : null;
}

function sameArtifact(a: TaskReviewArtifactRef, b: TaskReviewArtifactRef) {
  return (
    a.kind === b.kind &&
    (a.kind === 'answer' && b.kind === 'answer'
      ? a.sessionId === b.sessionId && a.turnId === b.turnId
      : 'id' in a && 'id' in b && a.id === b.id)
  );
}

const reviewMarkdownComponents: NonNullable<Options['components']> = {
  code: ({ node: _node, ...props }) => <code {...props} />,
  pre: ({ node: _node, ...props }) => <pre {...props} />,
};

export function ReviewDocumentView({
  artifact,
  draftScope,
  text: sourceText,
  title,
  threads = [],
  onCreateThread,
  onSelectThread,
}: {
  artifact: TaskReviewArtifactRef;
  /** Station/account and Task-incarnation identity supplied by the owner. */
  draftScope: string;
  text: string;
  title: string;
  threads?: readonly TaskReviewThreadView[];
  onCreateThread: (
    anchor: TaskReviewAnchor,
    body: string,
    quote?: string,
  ) => void | Promise<void>;
  onSelectThread?: (threadId: string) => void;
}) {
  const text = normalizeTaskReviewText(sourceText);
  const root = useRef<HTMLElement>(null);
  const mobile = useIsMobile();
  const [outline, setOutline] = useState<
    { id: string; label: string; start: number }[]
  >([]);
  const [selection, setSelection] = useState<{
    anchor: TaskReviewAnchor;
    quote: string;
    text: string;
    position: { left: number; top: number };
  }>();
  const [composing, setComposing] = useState(false);
  const [quickError, setQuickError] = useState<string>();
  const [quickPending, setQuickPending] = useState(false);
  const locations = useMemo(
    () =>
      threads.flatMap((thread) => {
        if (
          !sameArtifact(thread.artifact, artifact) ||
          thread.baseState === 'resolved' ||
          thread.anchor.kind !== 'text-quote'
        )
          return [];
        const location = relocateTextQuote(text, thread.anchor);
        return location.status === 'exact' || location.status === 'moved'
          ? [{ ...location, id: thread.threadId }]
          : [];
      }),
    [artifact, text, threads],
  );
  const sourcePlugin = useMemo(
    () => () => (tree: SourceNode) => {
      const visit = (
        parent: SourceNode,
        inherited?: Bounds,
        inCode = false,
      ) => {
        const start = parent.position?.start.offset ?? inherited?.start;
        const end = parent.position?.end.offset ?? inherited?.end;
        const bounds =
          start === undefined || end === undefined ? undefined : { start, end };
        const code = inCode || parent.tagName === 'code';
        if (
          parent.tagName &&
          /^(p|h[1-6]|li|pre|blockquote)$/.test(parent.tagName) &&
          bounds
        ) {
          parent.properties = {
            ...parent.properties,
            'data-review-block-start': start,
            'data-review-block-end': end,
            'data-review-line-start': parent.position?.start.line,
            'data-review-line-end': parent.position?.end.line,
          };
          if (/^h[1-6]$/.test(parent.tagName))
            parent.properties.id = `review-section-${start}`;
        }
        let cursor = bounds?.start;
        parent.children = parent.children?.flatMap((node): SourceNode[] => {
          if (node.type !== 'text' || node.value === undefined) {
            visit(
              node,
              bounds && { start: cursor ?? bounds.start, end: bounds.end },
              code,
            );
            if (node.position?.end.offset !== undefined)
              cursor = node.position.end.offset;
            else if (node.properties?.['data-review-mapped-end'] !== undefined)
              cursor = Number(node.properties['data-review-mapped-end']);
            return [node];
          }
          const leafBounds = {
            start: node.position?.start.offset ?? cursor ?? -1,
            end: node.position?.end.offset ?? bounds?.end ?? -1,
          };
          if (leafBounds.start < 0 || leafBounds.end < 0) return [node];
          const mapped = mapCharacters(text, node.value, leafBounds, code);
          if (!mapped) return [node];
          cursor = mapped.at(-1)![1];
          parent.properties = {
            ...parent.properties,
            'data-review-mapped-end': cursor,
          };
          const result: SourceNode[] = [];
          for (let from = 0; from < mapped.length; ) {
            const mark = locations.find(
              (location) =>
                mapped[from][0] >= location.start &&
                mapped[from][1] <= location.end,
            );
            let to = from + 1;
            while (
              to < mapped.length &&
              locations.find(
                (location) =>
                  mapped[to][0] >= location.start &&
                  mapped[to][1] <= location.end,
              )?.id === mark?.id
            )
              to++;
            result.push({
              type: 'element',
              tagName: mark ? 'mark' : 'span',
              properties: {
                'data-review-map': JSON.stringify(mapped.slice(from, to)),
                ...(mark
                  ? {
                      tabIndex: 0,
                      role: 'link',
                      'data-review-thread-link': mark.id,
                      'aria-label': `Open comment ${threads.find((t) => t.threadId === mark.id)?.ordinal}`,
                      'aria-controls': `review-thread-${mark.id}`,
                    }
                  : {}),
              },
              children: [{ type: 'text', value: node.value.slice(from, to) }],
            });
            from = to;
          }
          return result;
        });
        if (cursor !== undefined && parent.tagName)
          parent.properties = {
            ...parent.properties,
            'data-review-mapped-end': cursor,
          };
      };
      visit(tree);
    },
    [text, locations, threads],
  );
  useLayoutEffect(() => {
    if (!text) {
      setOutline([]);
      return;
    }
    setOutline(
      [
        ...(root.current?.querySelectorAll<HTMLElement>(
          'h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]',
        ) ?? []),
      ].map((heading) => ({
        id: heading.id,
        label: heading.textContent ?? '',
        start: Number(heading.dataset.reviewBlockStart),
      })),
    );
  }, [text]);

  function captureSelection() {
    const selected = window.getSelection();
    if (
      !selected ||
      selected.isCollapsed ||
      selected.rangeCount !== 1 ||
      selection
    )
      return false;
    const range = selected.getRangeAt(0);
    if (!root.current?.contains(range.commonAncestorContainer)) return false;
    const selectedNodes = document.createTreeWalker(
      root.current,
      NodeFilter.SHOW_TEXT,
    );
    for (
      let node = selectedNodes.nextNode();
      node;
      node = selectedNodes.nextNode()
    ) {
      if (
        range.intersectsNode(node) &&
        !node.parentElement?.closest('[data-review-map]') &&
        node.textContent?.trim()
      )
        return false;
    }
    const characters: Character[] = [];
    for (const span of root.current.querySelectorAll<HTMLElement>(
      '[data-review-map]',
    )) {
      const node = span.firstChild;
      if (!node || !range.intersectsNode(node)) continue;
      const from = range.startContainer === node ? range.startOffset : 0;
      const to =
        range.endContainer === node
          ? range.endOffset
          : (node.textContent?.length ?? 0);
      const map: Character[] = JSON.parse(span.dataset.reviewMap!);
      characters.push(...map.slice(from, to));
    }
    if (!characters.length) return false;
    const start = characters[0][0];
    const end = characters.at(-1)![1];
    const anchor = parseTaskReviewAnchor({
      kind: 'text-quote',
      start,
      end,
      exact: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - 32), start),
      suffix: text.slice(end, end + 32),
    });
    if (!anchor) return false;
    const rect = range.getBoundingClientRect?.();
    setSelection({
      anchor,
      quote: selected.toString().trim(),
      text,
      position: {
        left: Math.max(16, Math.min(rect?.left ?? 16, window.innerWidth - 368)),
        top: Math.max(
          16,
          Math.min((rect?.bottom ?? 16) + 8, window.innerHeight - 240),
        ),
      },
    });
    return true;
  }
  function selectBlock(element: HTMLElement) {
    const block =
      element.closest<HTMLElement>('[data-review-block-start]') ??
      (element === root.current
        ? element.querySelector<HTMLElement>('[data-review-block-start]')
        : null);
    if (!block || selection) return;
    const anchor = parseTaskReviewAnchor({
      kind: 'block',
      startLine: Number(block.dataset.reviewLineStart),
      endLine: Number(block.dataset.reviewLineEnd),
    });
    if (anchor?.kind === 'block') {
      const rect = block.getBoundingClientRect();
      setSelection({
        anchor,
        quote: text
          .split('\n')
          .slice(anchor.startLine - 1, anchor.endLine)
          .join('\n'),
        text,
        position: {
          left: Math.max(16, Math.min(rect.left, window.innerWidth - 368)),
          top: Math.max(
            16,
            Math.min(rect.bottom + 8, window.innerHeight - 240),
          ),
        },
      });
    }
  }
  function activateThread(element: HTMLElement) {
    const id = element.closest<HTMLElement>('[data-review-thread-link]')
      ?.dataset.reviewThreadLink;
    if (!id) return false;
    onSelectThread?.(id);
    document.getElementById(`review-thread-${id}`)?.focus();
    return true;
  }
  async function submit(body: string) {
    if (!selection) return;
    if (selection.text !== text)
      throw new Error('Document changed. Select text again.');
    await onCreateThread(selection.anchor, body, selection.quote);
  }
  async function approve() {
    if (quickPending) return;
    setQuickPending(true);
    setQuickError(undefined);
    try {
      await submit('Approved.');
      dismiss();
    } catch (cause) {
      setQuickError(
        cause instanceof Error ? cause.message : 'Could not save approval.',
      );
    } finally {
      setQuickPending(false);
    }
  }
  function dismiss() {
    setSelection(undefined);
    setComposing(false);
    root.current?.focus();
  }
  const changed = threads.find(
    (thread) =>
      sameArtifact(thread.artifact, artifact) &&
      thread.currentRevision !== undefined &&
      thread.currentRevision !== thread.artifact.revision,
  );
  return (
    <div className="review-document-layout" data-mobile={mobile || undefined}>
      {outline.length > 0 && (
        <nav className="review-outline" aria-label="Document outline">
          {outline.map((heading, index) => {
            const count = threads.filter((thread) => {
              if (
                !sameArtifact(thread.artifact, artifact) ||
                thread.baseState === 'resolved' ||
                thread.state === 'outdated'
              )
                return false;
              const start =
                thread.anchor.kind === 'text-quote'
                  ? locations.find(
                      (location) => location.id === thread.threadId,
                    )?.start
                  : thread.anchor.kind === 'block'
                    ? text
                        .split('\n')
                        .slice(0, thread.anchor.startLine - 1)
                        .reduce((offset, line) => offset + line.length + 1, 0)
                    : undefined;
              return (
                start !== undefined &&
                start >= heading.start &&
                start < (outline[index + 1]?.start ?? Infinity)
              );
            }).length;
            return (
              <Button
                key={heading.id}
                aria-label={`${heading.label}, ${count} open threads`}
                size="sm"
                variant="ghost"
                onClick={() => {
                  const headingNode = document.getElementById(heading.id);
                  headingNode?.scrollIntoView?.({ block: 'start' });
                  headingNode?.setAttribute('tabindex', '-1');
                  headingNode?.focus();
                }}
              >
                <span>{heading.label}</span>
                <span className="review-count">{count}</span>
              </Button>
            );
          })}
        </nav>
      )}
      <section className="review-document" aria-label={title}>
        <header className="review-document__header">
          <span className="review-document__title">
            <DocumentGlyph />
            {title}
          </span>
          <span className="review-chip">
            {changed
              ? `${changed.artifact.revision} → ${changed.currentRevision}`
              : artifact.revision}
          </span>
        </header>
        <article
          ref={root}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users select text and invoke C within this document
          tabIndex={0}
          className="review-document__markdown"
          aria-label={`${title} content`}
          onMouseUp={captureSelection}
          onKeyUp={(event) => {
            if (event.key.startsWith('Arrow') || event.key === 'Shift')
              captureSelection();
          }}
          onClick={(event) => {
            if (!window.getSelection()?.isCollapsed) return;
            if (!activateThread(event.target as HTMLElement))
              selectBlock(event.target as HTMLElement);
          }}
          onKeyDown={(event) => {
            if (
              selection &&
              event.key.toLowerCase() === 'a' &&
              !event.metaKey &&
              !event.altKey &&
              !event.ctrlKey
            ) {
              event.preventDefault();
              void approve();
              return;
            }
            if (selection && event.key === 'Escape') {
              event.preventDefault();
              dismiss();
              return;
            }
            if (
              event.key === 'Enter' &&
              activateThread(event.target as HTMLElement)
            ) {
              event.preventDefault();
              return;
            }
            if (
              !event.metaKey &&
              !event.ctrlKey &&
              !event.altKey &&
              event.key.toLowerCase() === 'c'
            ) {
              event.preventDefault();
              if (!selection && !captureSelection())
                selectBlock(event.target as HTMLElement);
              setComposing(true);
            }
          }}
        >
          <MarkdownRenderer
            rehypePlugins={[sourcePlugin]}
            components={reviewMarkdownComponents}
          >
            {text}
          </MarkdownRenderer>
        </article>
        {selection && !composing && (
          <div
            className="review-selection"
            data-mobile={mobile || undefined}
            role="toolbar"
            aria-label="Selection actions"
            style={{
              left: mobile ? undefined : selection.position.left,
              top: mobile ? undefined : selection.position.top,
            }}
            onKeyDown={(event) => {
              if (event.key.toLowerCase() === 'c') setComposing(true);
              if (event.key.toLowerCase() === 'a') void approve();
              if (event.key === 'Escape') dismiss();
            }}
          >
            <Button size="sm" onClick={() => setComposing(true)}>
              <MessageGlyph />
              Comment <kbd>C</kbd>
            </Button>
            <Button
              size="sm"
              title="Approve (A)"
              pending={quickPending}
              onClick={() => void approve()}
            >
              <CheckGlyph />
              <span className="sr-only">Approve</span>
              <kbd>A</kbd>
            </Button>
            <Button size="sm" aria-label="Dismiss selection" onClick={dismiss}>
              <CloseGlyph />
            </Button>
          </div>
        )}
        {quickError && <p role="alert">{quickError}</p>}
        {selection && composing && (
          <ReviewAnchorComposer
            draftKey={`${draftScope}:${JSON.stringify(artifact)}:${JSON.stringify(selection.anchor)}`}
            onCancel={dismiss}
            position={selection.position}
            onSubmit={submit}
          />
        )}
      </section>
    </div>
  );
}
