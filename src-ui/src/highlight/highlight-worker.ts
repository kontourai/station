/**
 * archive#3354 — chat syntax highlighting worker.
 *
 * Runs Shiki tokenization off the main thread, mirroring the pattern
 * DiffPanel established for diffs ("so large diffs don't
 * jank the UI"). Chat code blocks used to re-tokenize synchronously on the
 * main thread on every streaming flush; the work now happens here.
 *
 * Loaded only from the async `highlight-client.ts` chunk — never from the
 * entry bundle.
 */
import {
  createChatHighlighter,
  type HighlighterCore,
  loadHighlighterLanguage,
} from './core-highlighter';
import {
  IncrementalHighlightStore,
  sessionTokenizerFor,
} from './incremental-session';
import { THEME } from './shared';

type HighlightRequest = { id: number; code: string; lang: string };
type HighlightResponse = { id: number; html?: string; error?: string };

let highlighter: HighlighterCore | null = null;
let initPromise: Promise<HighlighterCore> | null = null;

async function ensureHighlighter(): Promise<HighlighterCore> {
  if (highlighter) return highlighter;
  if (!initPromise) {
    initPromise = createChatHighlighter().then((h) => {
      highlighter = h;
      return h;
    });
  }
  return initPromise;
}

const ctx = self as unknown as {
  addEventListener(type: 'message', handler: (e: MessageEvent) => void): void;
  postMessage(message: HighlightResponse): void;
};

/**
 * #2093 — resume store shared by every request this worker serves. Matching
 * is transparent (longest reusable `\n`-terminated prefix), so the message
 * protocol is unchanged: growing streamed blocks resume, everything else
 * takes the full path exactly as before. Bounded — one worker serves a page
 * of chat, not an archive.
 */
const sessions = new IncrementalHighlightStore(16);

ctx.addEventListener('message', async (e: MessageEvent) => {
  const { id, code, lang } = e.data as HighlightRequest;
  try {
    const h = await ensureHighlighter();
    const resolved = (await loadHighlighterLanguage(h, lang)) ? lang : 'text';
    const html = sessions.highlight(
      sessionTokenizerFor(h, THEME),
      code,
      resolved,
    );
    ctx.postMessage({ id, html });
  } catch (err) {
    ctx.postMessage({ id, error: String(err) });
  }
});
