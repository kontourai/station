import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import {
  HTML_REPLY_LIMITS,
  type HtmlReplyPage,
  type HtmlReplyReference,
  type PublishedHtmlReply,
} from '@kontourai/station-contracts/html-reply';
import { HtmlReplyRefusal } from '../html-reply-errors.js';

export function createHtmlReplyPages(
  db: {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...args: SQLInputValue[]): unknown;
      get(...args: SQLInputValue[]): unknown;
    };
  },
  sessionExists: (sessionId: string) => boolean,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS orchestration_html_reply_pages (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    page_json TEXT NOT NULL, bytes INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS html_reply_conversation ON orchestration_html_reply_pages(conversation_id)`);
  return {
    publish(
      sessionId: string,
      conversationId: string,
      page: HtmlReplyPage,
    ): HtmlReplyReference {
      const bytes = Buffer.byteLength(page.html);
      if (!sessionExists(sessionId))
        throw new HtmlReplyRefusal('HTML reply session no longer exists');
      if (
        page.version !== 1 ||
        bytes > HTML_REPLY_LIMITS.pageBytes ||
        !Number.isInteger(page.height) ||
        page.height < HTML_REPLY_LIMITS.minHeight ||
        page.height > HTML_REPLY_LIMITS.maxHeight
      )
        throw new HtmlReplyRefusal('Invalid HTML reply page');
      const reference: HtmlReplyReference = {
        version: 1,
        pageId: randomUUID(),
        sessionId,
      };
      const stored: PublishedHtmlReply = {
        ...page,
        reference,
        conversationId,
        createdAt: new Date().toISOString(),
      };
      const storedJson = JSON.stringify(stored);
      const storedBytes = Buffer.byteLength(storedJson);
      db.exec('BEGIN IMMEDIATE');
      try {
        if (!sessionExists(sessionId))
          throw new HtmlReplyRefusal('HTML reply session no longer exists');
        const usage = db
          .prepare(
            'SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes FROM orchestration_html_reply_pages WHERE conversation_id = ?',
          )
          .get(conversationId) as { count: number; bytes: number };
        if (usage.count >= 32 || usage.bytes + storedBytes > 32 * 1024 * 1024)
          throw new HtmlReplyRefusal(
            'HTML reply conversation exceeds 32 pages or 32 MiB',
          );
        db.prepare(
          'INSERT INTO orchestration_html_reply_pages (id, thread_id, conversation_id, page_json, bytes) VALUES (?, ?, ?, ?, ?)',
        ).run(
          reference.pageId,
          sessionId,
          conversationId,
          storedJson,
          storedBytes,
        );
        db.exec('COMMIT');
        return reference;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    read(reference: HtmlReplyReference): PublishedHtmlReply | undefined {
      const row = db
        .prepare(
          'SELECT page_json FROM orchestration_html_reply_pages WHERE id = ? AND thread_id = ?',
        )
        .get(reference.pageId, reference.sessionId) as
        | { page_json: string }
        | undefined;
      return row ? JSON.parse(row.page_json) : undefined;
    },
    deleteThread(sessionId: string): void {
      db.prepare(
        'DELETE FROM orchestration_html_reply_pages WHERE thread_id = ?',
      ).run(sessionId);
    },
  };
}
