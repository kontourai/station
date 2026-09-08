/**
 * The one Shiki highlighter this app builds, and the engine it builds it on.
 *
 * `createHighlighter` from the `shiki` root entry defaults to the Oniguruma
 * WebAssembly engine, so the first code block anyone highlighted downloaded
 * and instantiated a 622 KB (230 KB gzipped) wasm module. `shiki/core` takes
 * the engine as an argument, and the JavaScript RegExp engine is already in
 * this bundle — `@pierre/diffs` builds its diff highlighter on it — so the
 * chat worker and the file-preview provider now share that engine instead of
 * paying for a second one in wasm.
 *
 * `forgiving: true` is what makes that safe as a blanket switch. The JS engine
 * cannot express every Oniguruma pattern; without it, a grammar containing one
 * unsupported pattern throws at load and takes the whole highlighter with it.
 * Forgiving skips the individual pattern instead: the grammar loads, and at
 * worst one construct inside it goes unstyled. A missed highlight is a
 * cosmetic loss; a rejected `loadLanguage` is a code block rendered as plain
 * text, and a rejected `createHighlighterCore` is every code block on the page.
 *
 * The preload list is enumerated literally rather than built from
 * `PRELOAD_LANGS` with a template-literal import: a dynamic import whose
 * specifier is not a literal makes the bundler emit every module the pattern
 * could match, which for `@shikijs/langs` is 722 of them.
 */

import type { LanguageInput } from '@shikijs/types';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { PRELOAD_LANGS, THEME } from './shared';

export type { HighlighterCore };

const PRELOAD_LANG_LOADERS: Record<
  (typeof PRELOAD_LANGS)[number],
  LanguageInput
> = {
  typescript: () => import('@shikijs/langs/typescript'),
  javascript: () => import('@shikijs/langs/javascript'),
  tsx: () => import('@shikijs/langs/tsx'),
  jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
  python: () => import('@shikijs/langs/python'),
  rust: () => import('@shikijs/langs/rust'),
  go: () => import('@shikijs/langs/go'),
  java: () => import('@shikijs/langs/java'),
  bash: () => import('@shikijs/langs/bash'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  sql: () => import('@shikijs/langs/sql'),
  markdown: () => import('@shikijs/langs/markdown'),
  xml: () => import('@shikijs/langs/xml'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
};

/**
 * Every preload entry must have a loader. `PRELOAD_LANG_LOADERS` is typed by
 * `PRELOAD_LANGS`, so adding a language to the shared list without a loader
 * here is a compile error rather than a language that silently stops loading.
 */
export function createChatHighlighter(): Promise<HighlighterCore> {
  return createHighlighterCore({
    engine: createJavaScriptRegexEngine({ forgiving: true }),
    themes: [import('@shikijs/themes/github-dark')],
    langs: PRELOAD_LANGS.map((lang) => PRELOAD_LANG_LOADERS[lang]),
  });
}

export { THEME };

/**
 * On-demand load for a language outside the preload list — the path the chat
 * worker takes when a fenced block names something it has not registered yet.
 *
 * The bundled highlighter used to accept a bare string here and resolve it
 * through Shiki's own registry. `HighlighterCore` has no registry, so the
 * registry is loaded here, lazily: nothing is fetched unless an unrecognised
 * language actually appears, and the module is already in this bundle's graph
 * (`@pierre/diffs` imports the `shiki` root, which re-exports it), so keeping
 * full language coverage costs no additional chunk.
 *
 * Returns whether the language is now loaded, so the caller can fall back to
 * plain text rather than throwing at an unknown fence label.
 */
export async function loadHighlighterLanguage(
  highlighter: HighlighterCore,
  lang: string,
): Promise<boolean> {
  if (highlighter.getLoadedLanguages().includes(lang)) return true;
  try {
    const { bundledLanguages } = await import('shiki/langs');
    const loader = (
      bundledLanguages as Record<string, LanguageInput | undefined>
    )[lang];
    if (!loader) return false;
    await highlighter.loadLanguage(loader);
    return true;
  } catch {
    return false;
  }
}
