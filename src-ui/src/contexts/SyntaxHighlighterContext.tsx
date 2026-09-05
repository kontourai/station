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
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  escapeHtml,
  fnv1a,
  HighlightCache,
  PRELOAD_LANGS,
  THEME,
} from '../highlight/shared';

// ── Interface ─────────────────────────────────────────────────────

export interface ISyntaxHighlighter {
  highlight(code: string, lang?: string): string;
  readonly ready: boolean;
  readonly loadedLanguages: string[];
}

// ── Shiki singleton ───────────────────────────────────────────────

type ShikiHighlighter = Awaited<
  ReturnType<typeof import('shiki')['createHighlighter']>
>;

let shikiInstance: ShikiHighlighter | null = null;
let shikiPromise: Promise<ShikiHighlighter> | null = null;

/**
 * archive#3354 — exported for the async highlight client's main-thread
 * fallback (jsdom / failed worker bootstrap); interactive callers keep using
 * the provider.
 */
export function initShiki(): Promise<ShikiHighlighter> {
  if (shikiInstance) return Promise.resolve(shikiInstance);
  shikiPromise ??= import('shiki')
    .then(({ createHighlighter }) =>
      createHighlighter({ themes: [THEME], langs: [...PRELOAD_LANGS] }),
    )
    .then((highlighter) => {
      shikiInstance = highlighter;
      return highlighter;
    })
    .catch((error) => {
      shikiPromise = null;
      throw error;
    });
  return shikiPromise;
}

// ── File extension → language mapping ─────────────────────────────

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  md: 'markdown',
  mdx: 'markdown',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  xml: 'xml',
  svg: 'xml',
  dockerfile: 'dockerfile',
  graphql: 'graphql',
  gql: 'graphql',
  vue: 'vue',
  svelte: 'svelte',
};

export function langFromFilePath(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  // Handle "Dockerfile" with no extension
  if (path.toLowerCase().endsWith('dockerfile')) return 'dockerfile';
  return EXT_LANG[ext];
}

// ── Shiki implementation ──────────────────────────────────────────

class ShikiSyntaxHighlighter implements ISyntaxHighlighter {
  private cache = new HighlightCache();
  private highlighter: ShikiHighlighter | null = null;

  get ready() {
    return this.highlighter !== null;
  }
  get loadedLanguages() {
    return this.highlighter?.getLoadedLanguages() ?? [];
  }

  setHighlighter(h: ShikiHighlighter) {
    this.highlighter = h;
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
  request: () => void;
  ready: boolean;
} | null>(null);

export function SyntaxHighlighterProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [highlighter] = useState(() => {
    const value = new ShikiSyntaxHighlighter();
    if (shikiInstance) value.setHighlighter(shikiInstance);
    return value;
  });
  const [ready, setReady] = useState(highlighter.ready);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const request = useCallback(() => {
    if (highlighter.ready) return;
    void initShiki()
      .then((instance) => {
        if (!mounted.current) return;
        highlighter.setHighlighter(instance);
        setReady(true);
      })
      .catch(() => {
        // Plain escaped code remains readable; another consumer can retry initialization.
      });
  }, [highlighter]);
  const value = useMemo(
    () => ({ highlighter, request, ready }),
    [highlighter, request, ready],
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
    context?.request();
  }, [context?.request]);
  if (!context)
    throw new Error(
      'useSyntaxHighlighter must be used within SyntaxHighlighterProvider',
    );
  return context.highlighter;
}
