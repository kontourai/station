import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let script = '';
let stylesheet = '';

test.beforeAll(async () => {
  script = (
    await build({
      stdin: {
        resolveDir: ROOT,
        loader: 'tsx',
        contents: `
import React,{createRef,useState} from 'react';import{createRoot}from'react-dom/client';
import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import{setClientCredentialResolver}from'@kontourai/station-sdk/client';
import{ChatInputArea}from'./src-ui/src/components/chat/ChatInputArea';
import{PreviewProvider}from'./src-ui/src/contexts/PreviewContext';
import{expandComposerMentions}from'./src-ui/src/components/chat/composer-mention-wire';
const scope={apiBase:'http://station.test',authorityKey:'owner-a',isCurrent:()=>true};
setClientCredentialResolver(()=>({origin:scope.apiBase,requestAuthority:scope}));window.sent='';
const base={attachments:[],disabled:false,isSending:false,turnInFlight:false,modelSupportsAttachments:true,fontSize:14,dockHeight:500,canModelSelect:false,availableModels:[],modelQuery:null,commandQuery:null,slashCommands:[],onCancel:()=>{},onClearInput:()=>{},onRemoveAttachment:()=>{},onClearAttachments:()=>{},onModelSelect:()=>{},onModelReset:()=>{},onModelClose:()=>{},onModelOpen:()=>{},onModelRuntimeOptionChange:()=>{},onApprovalModeChange:()=>{},onCommandSelect:async()=>{},onCommandClose:()=>{},onHistoryUp:()=>{},onHistoryDown:()=>{},updateFromInput:()=>{},closeAll:()=>{}};
function App(){const[drafts,setDrafts]=useState({one:'',two:'second draft'});const[session,setSession]=useState('one');const input=drafts[session];const ref=createRef();const change=value=>setDrafts(old=>({...old,[session]:value}));return <main><nav><button onClick={()=>setSession('one')}>First chat</button><button onClick={()=>setSession('two')}>Second chat</button></nav><ChatInputArea {...base} sessionId={session} input={input} textareaRef={ref} workingDirectory="/repo/project" mentionRequestScope={scope} mentionAuthority="station-stable" onInputChange={change} onSend={async()=>{window.sent=expandComposerMentions(input,'/repo/project','station-stable').text??''}} /></main>}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><PreviewProvider><App/></PreviewProvider></QueryClientProvider>);`,
      },
      bundle: true,
      format: 'iife',
      jsx: 'automatic',
      write: false,
      platform: 'browser',
      define: {
        'process.env.NODE_ENV': '"production"',
        'import.meta.env.DEV': 'false',
      },
      loader: { '.css': 'empty' },
    })
  ).outputFiles[0].text;
  stylesheet = (
    await build({
      stdin: {
        contents:
          '@import "./src-ui/src/index.css";@import "./src-ui/src/components/chat/chat.css";main{margin-top:280px}',
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
    })
  ).outputFiles[0].text;
});

async function mount(page: Page) {
  await page.route(
    'http://station.test/api/**',
    rejectUnexpectedFixtureRequest,
  );
  await page.route('http://station.test/api/coding/files/search**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [
          { name: 'alpha.ts', path: 'src/alpha.ts', type: 'file' },
          {
            name: 'folder (odd)',
            path: 'src/folder (odd)',
            type: 'directory',
          },
          { name: 'zeta.ts', path: 'src/zeta.ts', type: 'file' },
        ],
        scanTruncated: false,
      }),
    }),
  );
  await page.route('http://station.test/', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://station.test/');
  await page.addStyleTag({ content: stylesheet });
  await page.addScriptTag({ content: script });
}

test('keyboard-selects a scoped mention and preserves it across mounted chat switches', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page);
  const composer = page.getByRole('textbox');
  await composer.click();
  await composer.pressSequentially('Review @src');
  await expect(
    page.getByRole('listbox', { name: 'Files and folders' }),
  ).toBeVisible();
  await composer.press('ArrowDown');
  await expect(page.getByRole('option').nth(1)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await composer.press('Enter');
  await expect(composer).toHaveValue('Review @folder (odd) ');
  await expect(composer).toBeFocused();
  await page.getByRole('button', { name: 'Second chat' }).click();
  await expect(composer).toHaveValue('second draft');
  await page.getByRole('button', { name: 'First chat' }).click();
  await expect(composer).toHaveValue('Review @folder (odd) ');
  await page.screenshot({
    path: testInfo.outputPath('composer-file-mention-390.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Send' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { sent: string }).sent),
    )
    .toBe('Review @"/repo/project/src/folder (odd)" ');
});
