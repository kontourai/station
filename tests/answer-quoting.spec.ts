/** Production quote selection, draft storage and source inspection with exact HTTP fixtures. */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { test } from './helpers/fixture-audit';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const text = 'Alpha **selected words** omega.';
let script = '';
let stylesheet = '';
test.beforeAll(async () => {
  const bundle = await build({
    stdin: {
      resolveDir: ROOT,
      loader: 'tsx',
      contents: `
      import { useRef, useState, useSyncExternalStore } from 'react';
      import { createRoot } from 'react-dom/client';
      import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import { QuoteSelectionToolbar } from './src-ui/src/components/chat/QuoteSelectionToolbar';
      import { SourceQuoteDrafts } from './src-ui/src/components/chat/SourceQuoteDrafts';
      import { MarkdownRenderer } from './src-ui/src/components/chat/MarkdownRenderer';
      import { chatDraftsStore } from './src-ui/src/contexts/chat-drafts-store';
      import { composeQuotedReply } from './src-ui/src/utils/answer-quotes';
      window.quoteAuthority = true;
      setClientCredentialResolver(() => ({ origin: "http://station.test", requestAuthority: { apiBase: "http://station.test", authorityKey: "fixture", isCurrent: () => window.quoteAuthority } }));
      const messages = [{ id: 'answer-a', sessionId: 'session-a', turnId: 'turn-a', role: 'assistant', answerEligible: true, content: ${JSON.stringify(text)} }];
      function Harness() {
        const root = useRef(null); const [input, setInput] = useState('Keep existing draft');
        const [sent, setSent] = useState(''); const [epoch, setEpoch] = useState(0);
        const quotes = useSyncExternalStore(chatDraftsStore.subscribe, () => chatDraftsStore.getQuotes('reply-a'));
        return <main data-epoch={epoch} style={{padding:24,position:'relative',zIndex:'var(--layer-dock)'}}>
          <div ref={root}><div data-quote-source-message="answer-a"><MarkdownRenderer>{messages[0].content}</MarkdownRenderer></div></div>
          <QuoteSelectionToolbar container={root} messages={messages} onQuote={(quote) => chatDraftsStore.addQuote('reply-a',quote)} />
          <label>Reply<textarea value={input} onChange={(e) => setInput(e.target.value)} /></label>
          <SourceQuoteDrafts origin="http://station.test" quotes={quotes} onRemove={(index) => chatDraftsStore.removeQuote('reply-a',index)} />
          <button onClick={() => { setSent(composeQuotedReply(input,quotes)); chatDraftsStore.clear('reply-a'); }}>Send reply</button>
          <button onClick={() => { window.quoteAuthority=false; setEpoch(epoch+1); }}>Revoke access</button>
          <section aria-label="Sent reply"><MarkdownRenderer>{sent}</MarkdownRenderer></section>
        </main>;
      }
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><Harness /></QueryClientProvider>);
    `,
    },
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    write: false,
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'empty' },
    plugins: [
      {
        name: 'captured-authority-fixture',
        setup(builder) {
          builder.onResolve({ filter: /ApiBaseContext$/ }, () => ({
            path: 'authority',
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            loader: 'js',
            contents:
              'const scope={apiBase:"http://station.test",authorityKey:"fixture",isCurrent:()=>window.quoteAuthority}; export const useHostRequestAuthorityScope=()=>scope; export const useApiBase=()=>({apiBase:scope.apiBase});',
          }));
        },
      },
    ],
  });
  script = bundle.outputFiles[0].text;
  const styles = await build({
    stdin: {
      contents:
        '@import "./src-ui/src/index.css"; @import "./src-ui/src/components/chat/chat.css";',
      resolveDir: ROOT,
      loader: 'css',
    },
    bundle: true,
    write: false,
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.png': 'dataurl' },
    plugins: [
      {
        name: 'public-assets',
        setup(builder) {
          builder.onResolve({ filter: /^\/(fonts\/|favicon)/ }, (args) => ({
            path: join(ROOT, 'src-ui/public', args.path.slice(1)),
          }));
        },
      },
    ],
  });
  stylesheet = styles.outputFiles[0].text;
});

async function mount(
  page: Page,
  response: () => { status?: number; revision?: string; text?: string },
) {
  await page.route('http://station.test/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>',
    }),
  );
  await page.route(
    'http://station.test/api/orchestration/sessions/session-a/turns/turn-a/quote-source',
    (route) => {
      const state = response();
      return route.fulfill({
        status: state.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: !state.status,
          data: {
            version: 1,
            sessionId: 'session-a',
            turnId: 'turn-a',
            messageId: 'answer-a',
            text: state.text ?? text,
            revision: state.revision ?? 'a'.repeat(64),
          },
        }),
      });
    },
  );
  await page.goto('http://station.test/');
  await page.addStyleTag({ content: stylesheet });
  await page.addScriptTag({ content: script });
  await page.evaluate(() => document.fonts.ready);
}
async function selectAndQuote(page: Page, keyboard = true) {
  const words = page
    .locator('strong')
    .filter({ hasText: 'selected words' })
    .first();
  const box = (await words.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(
    page.getByRole('button', { name: 'Quote in reply', exact: true }),
  ).toBeVisible();
  if (keyboard) {
    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('button', { name: 'Quote in reply', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
  } else {
    await page
      .getByRole('button', { name: 'Quote in reply', exact: true })
      .click();
  }
  await expect(
    page.getByRole('region', { name: 'Quoted context' }),
  ).toContainText('selected words');
}

test('selection retains the existing draft, produces removable context and keeps a source link after send', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page, () => ({}));
  await selectAndQuote(page);
  await expect(page.getByRole('textbox', { name: 'Reply' })).toHaveValue(
    'Keep existing draft',
  );
  await page.getByRole('button', { name: 'Remove quote 1' }).click();
  await expect(
    page.getByRole('region', { name: 'Quoted context' }),
  ).toHaveCount(0);
  await selectAndQuote(page);
  await page.getByRole('button', { name: 'Send reply' }).click();
  const sent = page.getByRole('region', { name: 'Sent reply' });
  await expect(sent).toContainText('Keep existing draft');
  await expect(sent).toContainText('selected words');
  await sent.getByRole('button', { name: 'Quoted answer' }).click();
  await expect(page.getByRole('dialog')).toContainText(
    'Source revision is unchanged',
  );
  await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: testInfo.outputPath('quote-source.png') });
  await page
    .getByRole('button', { name: 'Open source conversation', exact: true })
    .click();
  await expect(page).toHaveURL(/chat=session-a/);
  await expect(page).toHaveURL(/#station-message=answer-a$/);
});

test('changed or denied source never replaces the saved quote or displays cached current text', async ({
  page,
}) => {
  let changed = false;
  let denied = false;
  await mount(page, () =>
    denied
      ? { status: 404 }
      : changed
        ? { revision: 'b'.repeat(64), text: 'Changed current text' }
        : {},
  );
  await selectAndQuote(page, false);
  changed = true;
  await page.getByRole('button', { name: 'Inspect source' }).click();
  await expect(page.getByRole('dialog')).toContainText(
    'The source has changed',
  );
  await expect(page.getByRole('dialog')).toContainText('selected words');
  await page.getByRole('button', { name: 'Close quote source' }).click();
  denied = true;
  await page.getByRole('button', { name: 'Inspect source' }).click();
  await expect(page.getByRole('dialog')).toContainText('Source unavailable');
  await expect(page.getByRole('dialog')).not.toContainText(
    'Changed current text',
  );
});
