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
import { createHighlighter, type Highlighter } from 'shiki';
import { PRELOAD_LANGS, THEME } from './shared';

type HighlightRequest = { id: number; code: string; lang: string };
type HighlightResponse = { id: number; html?: string; error?: string };

let highlighter: Highlighter | null = null;
let initPromise: Promise<Highlighter> | null = null;

async function ensureHighlighter(): Promise<Highlighter> {
  if (highlighter) return highlighter;
  if (!initPromise) {
    initPromise = createHighlighter({
      themes: [THEME],
      langs: [...PRELOAD_LANGS],
    }).then((h) => {
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

ctx.addEventListener('message', async (e: MessageEvent) => {
  const { id, code, lang } = e.data as HighlightRequest;
  try {
    const h = await ensureHighlighter();
    let resolved = lang;
    if (!h.getLoadedLanguages().includes(resolved)) {
      try {
        await h.loadLanguage(resolved as never);
      } catch {
        resolved = 'text';
      }
    }
    const html = h.codeToHtml(code, { lang: resolved, theme: THEME });
    ctx.postMessage({ id, html });
  } catch (err) {
    ctx.postMessage({ id, error: String(err) });
  }
});
