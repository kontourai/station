/** Production request reply, file normalization, upload queue and SDK; exact server boundaries are fixtures. */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { build } from 'esbuild';
import { foregroundMessageReceiptEnvelope } from './helpers/execution-receipt';
import { test } from './helpers/fixture-audit';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let script = '';
let stylesheet = '';
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: ROOT,
      loader: 'tsx',
      contents: `
    import {useState} from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
    import {NeedsInputReply} from './src-ui/src/components/attention/NeedsInputReply';
    import {setClientCredentialResolver} from '@kontourai/station-sdk/client';
    import {chatDraftsStore} from './src-ui/src/contexts/chat-drafts-store';
    window.inputAuthority=true;
    const scope={apiBase:'http://station.test',authorityKey:'answer-owner',isCurrent:()=>window.inputAuthority};
    setClientCredentialResolver(()=>({origin:scope.apiBase,requestAuthority:scope}));
    chatDraftsStore.set('ordinary-chat','Unrelated prompt draft');
    window.readOrdinaryDraft=()=>chatDraftsStore.get('ordinary-chat');
    const make=(id)=>({id:'needs_input:'+id,kind:'needs_input',title:'Which file?',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',source:{threadId:id},openHref:'/?chat='+id,requestType:'input',inputReference:{threadId:id,requestId:'request-'+id,requestEventId:'opened-'+id}});
    function Harness(){const [changed,setChanged]=useState(false);const [epoch,setEpoch]=useState(0);const first=make('first');if(changed)first.inputReference.requestEventId='replacement';return <main style={{padding:16}} data-epoch={epoch}>
      <button onClick={()=>setChanged(true)}>Replace first request</button><button onClick={()=>{window.inputAuthority=false;setEpoch(epoch+1);}}>Revoke Station access</button>
      <section aria-label="First request"><NeedsInputReply item={first} scope={scope}/></section>
      <section aria-label="Second request"><NeedsInputReply item={make('second')} scope={scope}/></section>
    </main>;}
    createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><Harness/></QueryClientProvider>);
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
        name: 'model-observation',
        setup(builder) {
          builder.onResolve({ filter: /ModelCapabilitiesContext$/ }, () => ({
            path: 'unknown-model',
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            loader: 'js',
            contents: "export const useModelImageSupport=()=> 'unknown';",
          }));
        },
      },
    ],
  });
  script = result.outputFiles[0].text;
  const styles = await build({
    stdin: {
      contents:
        '@import "./src-ui/src/index.css";@import "./src-ui/src/components/attention/AttentionCard.css";@import "./src-ui/src/components/attention/NeedsInputReply.css";@import "./src-ui/src/components/chat/chat.css";',
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
  options: { failUpload?: boolean; failSend?: boolean } = {},
) {
  const sent: Array<Record<string, unknown>> = [];
  const prepared = new Map<string, Record<string, unknown>>();
  let uploadFailed = false;
  let sendFailed = false;
  await page.route('http://station.test/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>',
    }),
  );
  await page.route(
    /http:\/\/station\.test\/api\/orchestration\/sessions\/(first|second)\/input-requests\//,
    (route) => {
      const id = new URL(route.request().url()).pathname.split('/')[4];
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            state: 'open',
            reference: {
              threadId: id,
              requestId: 'request-' + id,
              requestEventId: 'opened-' + id,
            },
            agentId: 'agent-' + id,
            conversationId: 'conversation-' + id,
            provider: 'claude',
            engineId: 'claude',
            capabilities: ['file-input', 'image-input'],
          },
        }),
      });
    },
  );
  await page.route(
    'http://station.test/api/orchestration/attachment-staging/capability',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          state: 'supported',
          version: 1,
          maxConcurrentUploads: 3,
        }),
      }),
  );
  await page.route(
    'http://station.test/api/orchestration/attachment-staging/prepare',
    (route) => {
      const descriptor = route.request().postDataJSON();
      const stageId = 'stage-' + prepared.size;
      const entry = {
        ...descriptor,
        stageId,
        uploadGrant: 'fixture-upload-grant',
        expiresAt: '2030-01-01T00:00:00Z',
      };
      prepared.set(stageId, entry);
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(entry),
      });
    },
  );
  await page.route(
    /http:\/\/station\.test\/api\/orchestration\/attachment-staging\/stage-\d+$/,
    (route) => {
      if (options.failUpload && !uploadFailed) {
        uploadFailed = true;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Upload unavailable' }),
        });
      }
      const entry = prepared.get(
        new URL(route.request().url()).pathname.split('/').at(-1)!,
      );
      if (!entry) throw new Error('Unknown staged file');
      const { uploadGrant: _, ...descriptor } = entry;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ...descriptor,
          source: 'current-composer',
          digest: 'sha256-' + 'a'.repeat(64),
        }),
      });
    },
  );
  await page.route('http://station.test/api/orchestration/chat', (route) => {
    const body = route.request().postDataJSON();
    sent.push(body);
    if (options.failSend && !sendFailed) {
      sendFailed = true;
      return route.abort('connectionreset');
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        foregroundMessageReceiptEnvelope({
          conversationId: body.conversationId,
          sessionId: body.expectedInputRequest.threadId,
          providerTurnId: 'provider-turn',
          agent: body.target.agent,
          resolution: {
            provider: 'claude',
            engine: {
              kind: 'connection',
              connectionId: engineConnectionId('claude-runtime'),
            },
          },
        }),
      ),
    });
  });
  await page.goto('http://station.test/');
  await page.addStyleTag({ content: stylesheet });
  await page.addScriptTag({ content: script });
  await page.evaluate(() => document.fonts.ready);
  await expect(
    page
      .getByRole('region', { name: 'First request' })
      .getByRole('button', { name: 'Attach files' }),
  ).toBeEnabled();
  return { sent };
}

test('file-only answers retain upload failure and retry one immutable send without touching another draft', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mount(page, { failUpload: true, failSend: true });
  const first = page.getByRole('region', { name: 'First request' });
  const second = page.getByRole('region', { name: 'Second request' });
  await second.getByRole('textbox').fill('Separate answer');
  await first.getByLabel('Files for this answer').setInputFiles({
    name: 'answer.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hi'),
  });
  await expect(
    first.getByRole('button', { name: 'Send answer', exact: true }),
  ).toBeDisabled();
  await first
    .getByRole('button', { name: 'Retry answer.txt', exact: true })
    .click();
  await expect(
    first.getByRole('button', { name: 'Send answer', exact: true }),
  ).toBeEnabled();
  await first.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(first.getByRole('alert')).toContainText(
    'Retry sends the same answer',
  );
  await first
    .getByRole('button', { name: 'Retry same answer', exact: true })
    .click();
  await expect(first.getByRole('status')).toHaveText('Answer sent.');
  expect(fixture.sent).toHaveLength(2);
  expect(fixture.sent[1]).toEqual(fixture.sent[0]);
  expect(fixture.sent[0]).toMatchObject({
    conversationId: 'conversation-first',
    message: '',
    expectedInputRequest: {
      threadId: 'first',
      requestId: 'request-first',
      requestEventId: 'opened-first',
    },
    attachmentRefs: [{ name: 'answer.txt', kind: 'file' }],
  });
  expect(JSON.stringify(fixture.sent[0])).not.toContain('data:text');
  await expect(second.getByRole('textbox')).toHaveValue('Separate answer');
  expect(
    await page.evaluate(() => Reflect.get(window, 'readOrdinaryDraft')()),
  ).toBe('Unrelated prompt draft');
  await page.screenshot({
    path: testInfo.outputPath('attention-file-answer.png'),
  });
});

test('a replacement request or revoked Station access cannot dispatch the retained draft', async ({
  page,
}) => {
  const fixture = await mount(page);
  const first = page.getByRole('region', { name: 'First request' });
  await first.getByRole('textbox').fill('Original answer');
  await page.getByRole('button', { name: 'Replace first request' }).click();
  await expect(first.getByRole('alert')).toContainText('This request changed');
  await expect(first.getByRole('textbox')).toHaveValue('Original answer');
  await expect(
    first.getByRole('button', { name: 'Send answer', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Revoke Station access' }).click();
  await expect(first).toContainText('Station access changed');
  await expect(first.getByRole('textbox')).toHaveCount(0);
  expect(fixture.sent).toHaveLength(0);
});

test('an image-only answer stays bound to the second request', async ({
  page,
}) => {
  const fixture = await mount(page);
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    canvas.getContext('2d')!.fillRect(0, 0, 2, 2);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const second = page.getByRole('region', { name: 'Second request' });
  await second.getByLabel('Files for this answer').setInputFiles({
    name: 'answer.png',
    mimeType: 'image/png',
    buffer: Buffer.from(png, 'base64'),
  });
  await expect(
    second.getByRole('button', { name: 'Send answer', exact: true }),
  ).toBeEnabled();
  await second
    .getByRole('button', { name: 'Send answer', exact: true })
    .click();
  await expect(second.getByRole('status')).toHaveText('Answer sent.');
  expect(fixture.sent).toHaveLength(1);
  expect(fixture.sent[0]).toMatchObject({
    message: '',
    conversationId: 'conversation-second',
    expectedInputRequest: { threadId: 'second' },
    attachmentRefs: [{ kind: 'image', name: 'answer.png' }],
  });
});
