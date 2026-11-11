import { LazyMarkdown } from '../chat/LazyMarkdown';

/**
 * A room message body. Every author's text is Markdown, without raw HTML.
 * A leading `**@Name**` (how a Task-room mention is recorded) becomes a chip.
 */
export function RoomMessageText({ text }: { text: string }) {
  const mention = /^\*\*@(.+?)\*\*\s+/.exec(text);
  const body = mention ? text.slice(mention[0].length) : text;
  return (
    <div className="room-message-text task-room-message-text">
      {mention && <span className="task-room-mention">@{mention[1]}</span>}
      <LazyMarkdown
        skipHtml
        loadingProjection={<p className="room-message-text__source">{body}</p>}
      >
        {body}
      </LazyMarkdown>
    </div>
  );
}
