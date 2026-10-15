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
const scope={apiBase:'http://station.test',authorityKey:'owner-a',isCurrent:()=>true};
setClientCredentialResolver(()=>({origin:scope.apiBase,requestAuthority:scope}));
const base={attachments:[],disabled:false,turnInFlight:false,modelSupportsAttachments:true,fontSize:14,dockHeight:500,canModelSelect:false,availableModels:[],modelQuery:null,commandQuery:null,slashCommands:[],onCancel:()=>{},onClearInput:()=>{},onRemoveAttachment:()=>{},onClearAttachments:()=>{},onModelSelect:()=>{},onModelReset:()=>{},onModelClose:()=>{},onModelOpen:()=>{},onModelRuntimeOptionChange:()=>{},onApprovalModeChange:()=>{},onCommandSelect:async()=>{},onCommandClose:()=>{},onHistoryUp:()=>{},onHistoryDown:()=>{},updateFromInput:()=>{},closeAll:()=>{}};
function App(){const[drafts,setDrafts]=useState({one:'',two:'second draft'});const[session,setSession]=useState('one');const input=drafts[session];const ref=createRef();const change=value=>setDrafts(old=>({...old,[session]:value}));return <main><nav><button onClick={()=>setSession('one')}>First chat</button><button onClick={()=>setSession('two')}>Second chat</button></nav><ChatInputArea {...base} sessionId={session} input={input} textareaRef={ref} workingDirectory="/repo/project" mentionProjectSlug="project" mentionRequestScope={scope} mentionAuthority="station-stable" onInputChange={change} onSend={async()=>{}} /></main>}
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
  await composer.press('ArrowDown');
  await expect(
    page.getByRole('option', { name: /folder \(odd\)/ }),
  ).toHaveAttribute('aria-selected', 'true');
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
});

test('the mention picker opens above a phone composer without being clipped', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page);
  const composer = page.getByRole('textbox');
  await composer.click();
  await composer.pressSequentially('@');
  const options = page.getByRole('option');
  await expect(options).toHaveCount(3);
  // It opens above the composer capsule, not inside it pushing the input down.
  const listBox = await page
    .getByRole('listbox', { name: 'Files and folders' })
    .boundingBox();
  const capsuleBox = await page.locator('.chat-input__capsule').boundingBox();
  expect(listBox && capsuleBox).toBeTruthy();
  expect(listBox!.y + listBox!.height).toBeLessThanOrEqual(capsuleBox!.y);
  // A clipped option still has a box but is not what the pointer reaches:
  // each option must be the topmost element at its own centre.
  for (const option of await options.all()) {
    const reachable = await option.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      );
      return Boolean(hit && element.contains(hit));
    });
    expect(reachable).toBe(true);
  }
});

test('pressing inside the mention list keeps it open, and refocusing reopens it after blur', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page);
  const composer = page.getByRole('textbox');
  const list = page.getByRole('listbox', { name: 'Files and folders' });
  await composer.click();
  await composer.pressSequentially('Review @src');
  await expect(list).toBeVisible();
  // The list's own padding, not an option: focus must stay in the composer.
  const box = await list.boundingBox();
  await page.mouse.click(box!.x + 3, box!.y + 3);
  await expect(composer).toBeFocused();
  await expect(list).toBeVisible();
  await page.getByRole('button', { name: 'First chat' }).focus();
  await expect(list).toHaveCount(0);
  await composer.focus();
  await expect(list).toBeVisible();
});

test('a click refocus reopens the mention list only when the caret lands in the query', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page);
  const composer = page.getByRole('textbox');
  const list = page.getByRole('listbox', { name: 'Files and folders' });
  const away = page.getByRole('button', { name: 'First chat' });
  await composer.click();
  await composer.pressSequentially('@src');
  await expect(list).toBeVisible();
  const box = await composer.boundingBox();

  // Caret left at the start, then a click at the end of the query: reopens.
  await composer.press('Home');
  await away.focus();
  await expect(list).toHaveCount(0);
  await page.mouse.click(box!.x + box!.width - 12, box!.y + 12);
  await expect
    .poll(() => composer.evaluate((t: HTMLTextAreaElement) => t.selectionStart))
    .toBe(4);
  await expect(list).toBeVisible();

  // Caret left in the query, then a click at the start: stays closed.
  await away.focus();
  await expect(list).toHaveCount(0);
  await page.mouse.click(box!.x + 4, box!.y + 12);
  await expect
    .poll(() => composer.evaluate((t: HTMLTextAreaElement) => t.selectionStart))
    .toBe(0);
  // The refocus sync runs one frame after focus; let two frames pass.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(list).toHaveCount(0);
});
