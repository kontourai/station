import {
  parseTaskReviewAnchor,
  relocateTextQuote,
  type TaskReviewAnchor,
  type TaskReviewArtifactRef,
  type TaskReviewThread,
} from '@kontourai/station-contracts/task-review';
import { useMemo, useRef, useState } from 'react';
import { MarkdownRenderer } from '../../../components/chat/MarkdownRenderer';
import { DocumentGlyph } from '../../../components/icons/Glyph';
import { ReviewAnchorComposer } from './ReviewAnchorComposer';

interface SourceNode {
  type: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: SourceNode[];
  tagName?: string;
  properties?: Record<string, unknown>;
}

function sourceOffset(
  raw: string,
  rendered: string,
  offset: number,
): number | null {
  let source = 0;
  let display = 0;
  while (display < offset) {
    if (
      raw[source] === '\\' &&
      /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(raw[source + 1] ?? '')
    )
      source++;
    const entity = raw
      .slice(source)
      .match(/^&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/i)?.[0];
    if (entity) {
      const decoder = document.createElement('textarea');
      decoder.innerHTML = entity;
      const decoded = decoder.value;
      if (decoded !== entity && rendered.startsWith(decoded, display)) {
        if (display + decoded.length > offset) return null;
        source += entity.length;
        display += decoded.length;
        continue;
      }
    }
    if (raw[source] !== rendered[display]) return null;
    source++;
    display++;
  }
  return source;
}

export function ReviewDocumentView({
  artifact,
  text,
  title,
  threads = [],
  onCreateThread,
}: {
  artifact: TaskReviewArtifactRef;
  text: string;
  title: string;
  threads?: readonly TaskReviewThread[];
  onCreateThread: (
    anchor: TaskReviewAnchor,
    body: string,
  ) => void | Promise<void>;
}) {
  const root = useRef<HTMLElement>(null);
  const [selection, setSelection] = useState<{
    anchor: TaskReviewAnchor;
    text: string;
    position?: { left: number; top: number };
  }>();
  const sourcePlugin = useMemo(
    () => () => (tree: SourceNode) => {
      const locations = threads.flatMap((thread) => {
        if (
          thread.artifact.kind !== artifact.kind ||
          thread.artifact.id !== artifact.id ||
          thread.anchor.kind !== 'text-quote'
        )
          return [];
        const location = relocateTextQuote(text, thread.anchor);
        return location.status === 'exact' || location.status === 'moved'
          ? [location]
          : [];
      });
      const visit = (parent: SourceNode) => {
        parent.children = parent.children?.flatMap((node): SourceNode[] => {
          const start = node.position?.start.offset;
          const end = node.position?.end.offset;
          if (
            node.type !== 'text' ||
            start === undefined ||
            end === undefined ||
            node.value === undefined
          ) {
            if (node.children) visit(node);
            return [node];
          }
          const raw = text.slice(start, end);
          const highlighted = locations.filter(
            (location) => location.start < end && location.end > start,
          );
          const boundaries =
            raw === node.value
              ? [
                  ...new Set([
                    start,
                    end,
                    ...highlighted.flatMap((location) => [
                      Math.max(start, location.start),
                      Math.min(end, location.end),
                    ]),
                  ]),
                ].sort((a, b) => a - b)
              : [start, end];
          return boundaries.slice(0, -1).map((from, index) => {
            const to = boundaries[index + 1];
            const marked = highlighted.some(
              (location) => location.start < to && location.end > from,
            );
            return {
              type: 'element',
              tagName: marked ? 'mark' : 'span',
              properties: { 'data-review-start': from, 'data-review-end': to },
              children: [
                {
                  type: 'text',
                  value: raw === node.value ? text.slice(from, to) : node.value,
                },
              ],
            };
          });
        });
      };
      visit(tree);
    },
    [artifact.kind, artifact.id, text, threads],
  );

  function captureSelection() {
    if (selection) return;
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || selected.rangeCount !== 1) return;
    const range = selected.getRangeAt(0);
    const endpoint = (container: Node, offset: number) => {
      const element =
        container instanceof Element ? container : container.parentElement;
      const span = element?.closest<HTMLElement>('[data-review-start]');
      if (!span || !root.current?.contains(span)) return null;
      const prefix = document.createRange();
      prefix.selectNodeContents(span);
      prefix.setEnd(container, offset);
      const start = Number(span.dataset.reviewStart);
      const end = Number(span.dataset.reviewEnd);
      const local = sourceOffset(
        text.slice(start, end),
        span.textContent ?? '',
        prefix.toString().length,
      );
      return local === null ? null : start + local;
    };
    const start = endpoint(range.startContainer, range.startOffset);
    const end = endpoint(range.endContainer, range.endOffset);
    if (start === null || end === null || start >= end) return;
    const anchor = parseTaskReviewAnchor({
      kind: 'text-quote',
      start,
      end,
      exact: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - 32), start),
      suffix: text.slice(end, end + 32),
    });
    if (anchor) {
      const rect = range.getBoundingClientRect?.();
      setSelection({
        anchor,
        text,
        position: rect
          ? {
              left: Math.max(16, Math.min(rect.left, window.innerWidth - 368)),
              top: Math.max(
                16,
                Math.min(rect.bottom + 8, window.innerHeight - 240),
              ),
            }
          : undefined,
      });
    }
  }

  return (
    <section className="review-document" aria-label={title}>
      <header className="review-document__header">
        <span className="review-chip">
          <DocumentGlyph />
          {title}
        </span>
        <span className="review-chip">{artifact.revision}</span>
      </header>
      <article
        ref={root}
        className="review-document__markdown"
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
      >
        <MarkdownRenderer rehypePlugins={[sourcePlugin]}>
          {text}
        </MarkdownRenderer>
      </article>
      {selection && (
        <ReviewAnchorComposer
          position={selection.position}
          onCancel={() => setSelection(undefined)}
          onSubmit={(body) => {
            if (selection.text !== text)
              throw new Error('Document changed. Select text again.');
            return onCreateThread(selection.anchor, body);
          }}
        />
      )}
    </section>
  );
}
