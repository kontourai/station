/** Versioned page bytes, separate from the deliberately data-only UIBlock. */
export interface HtmlReplyPage {
  version: 1;
  html: string;
  height: number;
}

/** A reference is display data, never permission to read the retained page. */
export interface HtmlReplyReference {
  version: 1;
  pageId: string;
  sessionId: string;
}

export interface PublishedHtmlReply extends HtmlReplyPage {
  reference: HtmlReplyReference;
  conversationId: string;
  createdAt: string;
}

export const HTML_REPLY_LIMITS = {
  sourceBytes: 256 * 1024,
  imageBytes: 2 * 1024 * 1024,
  pageBytes: 8 * 1024 * 1024,
  images: 32,
  minHeight: 100,
  maxHeight: 2000,
} as const;

export const HTML_REPLY_THEME_KEYS = [
  'background',
  'foreground',
  'muted',
  'border',
  'accent',
  'destructive',
  'success',
  'warning',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'chart-6',
  'radius',
  'font-sans',
  'font-mono',
] as const;

export type HtmlReplyTheme = Partial<
  Record<(typeof HTML_REPLY_THEME_KEYS)[number], string>
>;
