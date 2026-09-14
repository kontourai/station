/**
 * @vitest-environment jsdom
 *
 * #2093 — a growing streamed code block re-tokenizes the whole block on every
 * flush, so worker cost per block is O(frames × length). The session store
 * must return byte-identical HTML to a full highlight while only tokenizing
 * appended lines (Shiki grammar-state resume), dropping that toward O(length).
 *
 * Two layers: a fake tokenizer pins the protocol (what gets tokenized, when),
 * and the real Shiki core pins output equality (resume must not change a single
 * span, including across mid-line flush cuts and multi-line constructs).
 */

import type { GrammarState } from 'shiki/core';
import { describe, expect, test } from 'vitest';
import {
  IncrementalHighlightStore,
  type SessionTokenizer,
} from '../highlight/incremental-session';

function makeRecordingTokenizer() {
  const calls: Array<{ kind: 'full' | 'suffix'; code: string }> = [];
  // Mirrors Shiki's observed output shape (probed, and pinned by the real-core
  // test below): one `<span class="line">` per line including the empty span a
  // trailing '\n' opens. The store's splice drops exactly that cursor span.
  const shape = (code: string) =>
    `<pre class="shiki"><code>${code
      .split('\n')
      .map((line) => `<span class="line">${line}</span>`)
      .join('\n')}</code></pre>`;
  const tokenizer: SessionTokenizer = {
    highlightFull: (code: string, _lang: string) => {
      calls.push({ kind: 'full', code });
      return {
        html: shape(code),
        state: { at: code } as unknown as GrammarState,
      };
    },
    highlightSuffix: (suffix: string, _lang: string, state: GrammarState) => {
      calls.push({ kind: 'suffix', code: suffix });
      return { html: shape(suffix), state };
    },
  };
  return { calls, tokenizer };
}

describe('IncrementalHighlightStore protocol', () => {
  test('a line-boundary append tokenizes only the suffix', () => {
    const { calls, tokenizer } = makeRecordingTokenizer();
    const store = new IncrementalHighlightStore();
    const first = store.highlight(tokenizer, 'const a = 1;\n', 'ts');
    expect(calls).toEqual([{ kind: 'full', code: 'const a = 1;\n' }]);

    const second = store.highlight(
      tokenizer,
      'const a = 1;\nconst b = 2;\n',
      'ts',
    );
    expect(calls).toEqual([
      { kind: 'full', code: 'const a = 1;\n' },
      { kind: 'suffix', code: 'const b = 2;\n' },
    ]);
    // The merged output is exactly the full highlight of the new code.
    expect(second).toBe(
      tokenizer.highlightFull('const a = 1;\nconst b = 2;\n', 'ts').html,
    );
    expect(second).toContain('const a = 1;');
    expect(second).toContain('const b = 2;');
    void first;
  });

  test('an identical repeat tokenizes nothing', () => {
    const { calls, tokenizer } = makeRecordingTokenizer();
    const store = new IncrementalHighlightStore();
    const code = 'const a = 1;\n';
    const first = store.highlight(tokenizer, code, 'ts');
    expect(store.highlight(tokenizer, code, 'ts')).toBe(first);
    expect(calls).toHaveLength(1);
  });

  test('a mid-block edit and a language change fall back to full', () => {
    const { calls, tokenizer } = makeRecordingTokenizer();
    const store = new IncrementalHighlightStore();
    store.highlight(tokenizer, 'const a = 1;\nconst b = 2;\n', 'ts');
    // Edit in the middle is not an append: full re-highlight.
    store.highlight(tokenizer, 'const a = 1;\nconst B = 2;\n', 'ts');
    // A different language never resumes another language's state.
    store.highlight(tokenizer, 'const a = 1;\nconst B = 2;\n', 'js');
    expect(calls.map((call) => call.kind)).toEqual(['full', 'full', 'full']);
  });

  test('sessions are bounded', () => {
    const { tokenizer } = makeRecordingTokenizer();
    const store = new IncrementalHighlightStore(4);
    for (let i = 0; i < 10; i++) {
      store.highlight(tokenizer, `// block ${i}\n`, 'ts');
    }
    expect(store.size).toBeLessThanOrEqual(4);
  });
});

describe('IncrementalHighlightStore against real Shiki', () => {
  test('resume output equals full output at every growth step', async () => {
    const { createChatHighlighter } = await import(
      '../highlight/core-highlighter'
    );
    const { THEME } = await import('../highlight/shared');
    const highlighter = await createChatHighlighter();
    const full = (code: string, lang: string) =>
      highlighter.codeToHtml(code, { lang, theme: THEME });
    const tokenizer: SessionTokenizer = {
      highlightFull: (code: string, lang: string) => {
        const html = full(code, lang);
        const state = highlighter.getLastGrammarState(
          highlighter.codeToHast(code, { lang, theme: THEME }),
        );
        return { html, state };
      },
      highlightSuffix: (suffix: string, lang: string, state: GrammarState) => {
        const html = highlighter.codeToHtml(suffix, {
          lang,
          theme: THEME,
          grammarState: state,
        });
        const next = highlighter.getLastGrammarState(
          highlighter.codeToHast(suffix, {
            lang,
            theme: THEME,
            grammarState: state,
          }),
        );
        return { html, state: next };
      },
    };

    // Growth cuts mid-line, mid-expression, and inside multi-line constructs.
    // Steps ending with '\n' are the ones that resume (the store only resumes
    // from a complete last line); the rest prove the full fallback is exact.
    // `${` cannot appear literally in a fixture (noTemplateCurlyInString), so
    // the template placeholder is assembled once here.
    const placeholder = '$' + '{a}';
    const head = '/* leading comment\nconst a = `template ';
    const steps = [
      '/* lead',
      '/* leading comment\nconst a = `tem',
      `${head}${placeholder.slice(0, 3)}`,
      `${head}${placeholder} + ${'b'}\`;\n`,
      `${head}${placeholder} + ${'b'}\`;\nconst c = `,
      `${head}${placeholder} + ${'b'}\`;\nconst c = 42;\n`,
      `${head}${placeholder} + ${'b'}\`;\nconst c = 42;\nconst d = c;\n`,
    ];
    const store = new IncrementalHighlightStore();
    for (const code of steps) {
      expect(store.highlight(tokenizer, code, 'ts')).toBe(full(code, 'ts'));
    }

    // A triple-quoted string carries grammar state across several lines.
    const python = [
      'x = """start',
      'x = """start\nmiddle\n',
      'x = """start\nmiddle\nend"""\n',
      'x = """start\nmiddle\nend"""\ny = 2\n',
    ];
    const pythonStore = new IncrementalHighlightStore();
    for (const code of python) {
      expect(store.highlight(tokenizer, code, 'python')).toBe(
        full(code, 'python'),
      );
      expect(pythonStore.highlight(tokenizer, code, 'python')).toBe(
        full(code, 'python'),
      );
    }
  });
});
