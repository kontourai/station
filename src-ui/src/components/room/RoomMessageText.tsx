import { useMemo } from 'react';
import { LazyMarkdown } from '../chat/LazyMarkdown';

/** A structured person mention in a message (#4799). */
export interface RoomTextMention {
  readonly actorId: string;
  /** The name when it was written: shown when the person is not known now. */
  readonly display: string;
  /** UTF-16 offset of the `@display` span in the text. */
  readonly offset: number;
}

// Private-use marks stand in for each mention while the Markdown parses, so a
// name never becomes Markdown and a mention survives emphasis around it.
const OPEN = '\uE000';
const CLOSE = '\uE001';
const MARK = /\uE000(\d+)\uE001/g;

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Turns each mark into a mention chip, labelled with the current name. */
function rehypeMentions(labels: readonly { name: string; self: boolean }[]) {
  const visit = (node: HastNode) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child): HastNode[] => {
      if (child.type !== 'text' || !child.value?.includes(OPEN)) {
        visit(child);
        return [child];
      }
      const parts: HastNode[] = [];
      let last = 0;
      for (const match of child.value.matchAll(MARK)) {
        const label = labels[Number(match[1])];
        if (match.index > last)
          parts.push({
            type: 'text',
            value: child.value.slice(last, match.index),
          });
        parts.push({
          type: 'element',
          tagName: 'span',
          properties: {
            className: label?.self
              ? ['room-mention', 'room-mention--self']
              : ['room-mention'],
          },
          children: [{ type: 'text', value: `@${label?.name ?? ''}` }],
        });
        last = match.index + match[0].length;
      }
      if (last < child.value.length)
        parts.push({ type: 'text', value: child.value.slice(last) });
      return parts;
    });
  };
  return () => (tree: HastNode) => visit(tree);
}

/**
 * A room message body. Every author's text is Markdown, without raw HTML.
 * Structured mentions (#4799) render as chips by person id, with the name
 * `nameOf` knows now, so a rename shows on old messages; the stored name is
 * the fallback. A leading `**@Name**` (how a Task-room Agent mention was
 * recorded before structured mentions) still becomes a chip.
 */
export function RoomMessageText({
  text,
  mentions,
  nameOf,
  selfId,
}: {
  text: string;
  mentions?: readonly RoomTextMention[];
  nameOf?: (actorId: string) => string | undefined;
  /** The reader: a mention of them stands out. */
  selfId?: string;
}) {
  const legacy = mentions?.length ? null : /^\*\*@(.+?)\*\*\s+/.exec(text);
  const legacyLength = legacy?.[0].length ?? 0;
  const { body, plain, plugins } = useMemo(() => {
    const source = text.slice(legacyLength);
    if (!mentions?.length)
      return { body: source, plain: source, plugins: undefined };
    const labels = mentions.map((mention) => ({
      name: nameOf?.(mention.actorId) ?? mention.display,
      self: mention.actorId === selfId,
    }));
    let marked = '';
    let plainText = '';
    let at = 0;
    mentions.forEach((mention, index) => {
      const before = source
        .slice(at, mention.offset)
        .replace(/[\uE000\uE001]/g, '');
      marked += `${before}${OPEN}${index}${CLOSE}`;
      plainText += `${before}@${labels[index]!.name}`;
      at = mention.offset + 1 + mention.display.length;
    });
    const rest = source.slice(at).replace(/[\uE000\uE001]/g, '');
    return {
      body: marked + rest,
      plain: plainText + rest,
      plugins: [rehypeMentions(labels)],
    };
  }, [text, legacyLength, mentions, nameOf, selfId]);
  return (
    <div className="room-message-text task-room-message-text">
      {legacy && <span className="task-room-mention">@{legacy[1]}</span>}
      <LazyMarkdown
        skipHtml
        rehypePlugins={plugins}
        loadingProjection={<p className="room-message-text__source">{plain}</p>}
      >
        {body}
      </LazyMarkdown>
    </div>
  );
}
