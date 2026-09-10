/**
 * Core syntax highlighting provider — Shiki-based, lazy-loaded, cached.
 *
 * Consumed by:
 *   - Workspace File Preview pane
 *   - UIBlockRenderer code blocks; chat markdown uses the highlight worker
 *   - Any future component needing syntax highlighting
 */

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { escapeHtml, fnv1a, HighlightCache, THEME } from '../highlight/shared';

// ── Interface ─────────────────────────────────────────────────────

export interface ISyntaxHighlighter {
  highlight(code: string, lang?: string): string;
  readonly ready: boolean;
  readonly loadedLanguages: string[];
}

// ── Shiki singleton ───────────────────────────────────────────────

type ShikiHighlighter = Awaited<
  ReturnType<
    typeof import('../highlight/core-highlighter')['createChatHighlighter']
  >
>;

let shikiPromise: Promise<ShikiHighlighter> | null = null;

/**
 * archive#3354 — exported for the async highlight client's main-thread
 * fallback (jsdom / failed worker bootstrap); interactive callers keep using
 * the provider.
 *
 * The factory stays behind a dynamic import: this module is reachable from
 * the entry chunk, and Shiki is not something a first paint should carry.
 */
export function initShiki(): Promise<ShikiHighlighter> {
  shikiPromise ??= import('../highlight/core-highlighter')
    .then(({ createChatHighlighter }) => createChatHighlighter())
    .catch((error) => {
      shikiPromise = null;
      throw error;
    });
  return shikiPromise;
}

// ── Shiki implementation ──────────────────────────────────────────

class ShikiSyntaxHighlighter implements ISyntaxHighlighter {
  private cache = new HighlightCache();
  constructor(private readonly highlighter: ShikiHighlighter | null) {}

  get ready() {
    return this.highlighter !== null;
  }
  get loadedLanguages() {
    return this.highlighter?.getLoadedLanguages() ?? [];
  }

  highlight(code: string, lang?: string): string {
    if (!this.highlighter) return escapeHtml(code);

    const resolvedLang =
      lang && this.highlighter.getLoadedLanguages().includes(lang)
        ? lang
        : 'text';
    const cacheKey = `${resolvedLang}:${fnv1a(code)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      const html = this.highlighter.codeToHtml(code, {
        lang: resolvedLang,
        theme: THEME,
      });
      this.cache.set(cacheKey, html);
      return html;
    } catch {
      const fallback = `<pre style="background:#0d1117;color:#e6edf3;padding:12px;border-radius:6px;overflow-x:auto"><code>${escapeHtml(code)}</code></pre>`;
      this.cache.set(cacheKey, fallback);
      return fallback;
    }
  }
}

// ── React Context ─────────────────────────────────────────────────

const SyntaxHighlighterContext = createContext<{
  highlighter: ISyntaxHighlighter;
  request: (requested: boolean) => void;
} | null>(null);

export function SyntaxHighlighterProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [highlighter, setHighlighter] = useState(
    () => new ShikiSyntaxHighlighter(null),
  );
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    if (!requested || highlighter.ready) return;
    let cancelled = false;
    void initShiki()
      .then((instance) => {
        if (!cancelled) setHighlighter(new ShikiSyntaxHighlighter(instance));
      })
      .catch(() => {
        // Keep escaped code and let a later consumer retry; never spin on failures.
        if (!cancelled) setRequested(false);
      });
    return () => {
      cancelled = true;
    };
  }, [requested, highlighter]);
  const value = useMemo(
    () => ({ highlighter, request: setRequested }),
    [highlighter],
  );
  return (
    <SyntaxHighlighterContext.Provider value={value}>
      {children}
    </SyntaxHighlighterContext.Provider>
  );
}

export function useSyntaxHighlighter(): ISyntaxHighlighter {
  const context = useContext(SyntaxHighlighterContext);
  useEffect(() => {
    context?.request(true);
  }, [context?.request]);
  if (!context)
    throw new Error(
      'useSyntaxHighlighter must be used within SyntaxHighlighterProvider',
    );
  return context.highlighter;
}
