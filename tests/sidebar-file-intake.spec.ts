/** Actual sidebar rows, composer receiver and staging; CDP supplies an external OS-file drag. */
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let script = '';
let stylesheet = '';
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: ROOT,
      loader: 'tsx',
      contents: `
import {useState,useSyncExternalStore} from 'react'; import {createRoot} from 'react-dom/client';
import {SidebarOpenChats} from './src-ui/src/components/project-sidebar/SidebarOpenChats';
import {useChatInput} from './src-ui/src/hooks/useChatInput';
import {activeChatsStore as store} from './src-ui/src/contexts/active-chats-store';
import {setClientCredentialResolver} from '@kontourai/station-sdk/client';
window.authorized=true; window.sendCount=0;
window.scope={apiBase:'http://station.test',authorityKey:'sidebar-owner',isCurrent:()=>window.authorized};
setClientCredentialResolver(()=>({origin:window.scope.apiBase,requestAuthority:window.scope}));
for (const id of ['source','target','readonly']) {store.initChat(id,{agentSlug:'agent',agentName:'Agent',title:id});store.updateChat(id,{input:id+' draft',conversationOpenFailed:id==='readonly'});}
const existing={id:'existing',name:'existing.txt',type:'text/plain',size:3,data:'data:text/plain;base64,b2xk'};
store.updateChat('target',{attachments:[existing]});
const items=['source','target','readonly'].map(id=>({id,kind:'chat',kindLabel:'Chat',title:id,projectLabel:'Project',agentLabel:'Agent',modelLabel:'Model',updatedAt:'2026-09-01T00:00:00Z',lifecycleLabel:'Idle'}));
function Harness(){const [selected,setSelected]=useState('source'); const chats=useSyncExternalStore(store.subscribe,store.getSnapshot);const input=useChatInput({apiBase:window.scope.apiBase,sessionId:selected,agentSlug:'agent',availableModels:[],attachmentCapabilities:{files:true,images:true}});
return <main style={{display:'flex',gap:24,padding:16}}><aside style={{width:260}}><SidebarOpenChats items={items} now={Date.now()} onActivate={item=>setSelected(item.id)}/></aside><section aria-label="Selected draft"><h1>{selected}</h1><textarea aria-label="Draft text" value={input.input} onChange={e=>input.handleInputChange(e.target.value)}/><ul>{input.attachments.map(file=><li key={file.id}>{file.name}</li>)}</ul><output aria-label="Staging">{(chats[selected].attachmentStages??[]).map(stage=>stage.state).join(',')}</output><button onClick={()=>setSelected('source')}>View source</button></section></main>;}
createRoot(document.getElementById('root')).render(<Harness/>);
`,
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
    plugins: [
      {
        name: 'environment-only',
        setup(b) {
          const fixtures = {
            ApiBaseContext:
              'export const useHostRequestAuthorityScope=()=>window.scope; export const useApiBase=()=>({apiBase:window.scope.apiBase});',
            AgentsContext:
              'export const useAgent=()=>null;export const useAgents=()=>[];',
            ToastContext:
              'export const useToast=()=>({showToast:()=>{}});export const toastStore={showToast:()=>{}};',
            useActiveChatSessions:
              "export const useSendMessage=()=>()=>{window.sendCount++;throw Error('Unexpected send');};export const useCancelMessage=()=>()=>{};",
            useSlashCommands:
              'export const useSlashCommands=()=>({commands:[]});',
            useSlashCommandHandler:
              'export const useSlashCommandHandler=()=>()=>{};',
            ActiveChatsContext: `import {useSyncExternalStore} from 'react';import {activeChatsStore as s} from '${ROOT}/src-ui/src/contexts/active-chats-store';const actions=Object.fromEntries(['updateChat','clearInput','addEphemeralMessage','addToInputHistory','navigateHistoryUp','navigateHistoryDown'].map(k=>[k,s[k].bind(s)]));export const useActiveChatActions=()=>actions;export const useActiveChatSelector=(id,select)=>select(useSyncExternalStore(s.subscribe,s.getSnapshot)[id]??null);`,
          };
          b.onResolve(
            {
              filter:
                /(ApiBaseContext|AgentsContext|ToastContext|ActiveChatsContext|useActiveChatSessions|useSlashCommands|useSlashCommandHandler)$/,
            },
            (a) => ({
              path: a.path.split('/').at(-1),
              namespace: 'environment',
            }),
          );
          b.onLoad({ filter: /.*/, namespace: 'environment' }, (a) => ({
            contents: fixtures[a.path],
            loader: 'js',
            resolveDir: ROOT,
          }));
        },
      },
    ],
  });
  script = result.outputFiles[0].text;
  const styles = await build({
    stdin: {
      contents:
        '@import "./src-ui/src/index.css";@import "./src-ui/src/components/project-sidebar/SidebarOpenChats.css";@import "./src-ui/src/components/chat-dock/ChatDockInboxPanel.css";@import "./src-ui/src/components/chat/chat.css";',
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

async function mount(page: Page) {
  page.on('pageerror', (error) =>
    console.error('Harness page error:', error.message),
  );
  const prepared = new Map<string, Record<string, unknown>>();
  await page.route(
    'http://station.test/api/**',
    rejectUnexpectedFixtureRequest,
  );
  await page.route('http://station.test/', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
    }),
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

  await page.route(
    'http://station.test/api/orchestration/attachment-staging/reconcile',
    (route) => {
      const { stageIds } = route.request().postDataJSON();
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(
          stageIds.map((id: string) => {
            const entry = prepared.get(id);
            if (!entry) throw Error('Unknown stage');
            const { uploadGrant: _, ...descriptor } = entry;
            return {
              stageId: id,
              state: 'complete',
              reference: {
                ...descriptor,
                source: 'current-composer',
                digest: 'sha256-' + 'a'.repeat(64),
              },
            };
          }),
        ),
      });
    },
  );
  await page.goto('http://station.test/');
  await page.addStyleTag({ content: stylesheet });
  await page.addScriptTag({ content: script });
  await expect(
    page.getByRole('heading', { name: 'source', exact: true }),
  ).toBeVisible();
  return prepared;
}
async function drop(
  page: Page,
  name: string,
  path: string,
  screenshot?: string,
) {
  const row = page.getByRole('group', { name: 'Chat ' + name, exact: true });
  const box = await row.boundingBox();
  if (!box) throw Error('Missing sidebar row');
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files: [path], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver'] as const)
    await cdp.send('Input.dispatchDragEvent', {
      type,
      x: box.x + 40,
      y: box.y + box.height / 2,
      data,
    });
  await expect(row.getByRole('status')).toContainText('Add 1 file');
  expect(await row.boundingBox()).toEqual(box);
  if (screenshot) await page.screenshot({ path: screenshot });
  await cdp.send('Input.dispatchDragEvent', {
    type: 'drop',
    x: box.x + 40,
    y: box.y + box.height / 2,
    data,
  });
  await cdp.detach();
}
test('sidebar file drop opens only the target draft, stages once and preserves both drafts', async ({
  page,
}, testInfo) => {
  const prepared = await mount(page);
  const path = testInfo.outputPath('intake.txt');
  await writeFile(path, 'sidebar file');
  await drop(
    page,
    'target',
    path,
    testInfo.outputPath('sidebar-drag-hint.png'),
  );
  await expect(
    page.getByRole('heading', { name: 'target', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Draft text' })).toHaveValue(
    'target draft',
  );
  await expect(page.getByRole('listitem')).toHaveText([
    'existing.txt',
    'intake.txt',
  ]);
  await expect(page.getByLabel('Staging')).toHaveText('complete');
  expect(prepared.size).toBe(1);
  await page.screenshot({
    path: testInfo.outputPath('sidebar-target-draft.png'),
  });
  await page.getByRole('button', { name: 'View source', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Draft text' })).toHaveValue(
    'source draft',
  );
  await expect(page.getByRole('listitem')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, 'sendCount'))).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('sidebar-intake.png') });
});
test('read-only row refuses intake and remains a normal navigable row', async ({
  page,
}, testInfo) => {
  const prepared = await mount(page);
  await page.evaluate(() =>
    document.documentElement.setAttribute('data-theme', 'light'),
  );
  const path = testInfo.outputPath('refused.txt');
  await writeFile(path, 'keep out');
  await drop(page, 'readonly', path);
  await expect(page.getByRole('alert')).toContainText(
    'unavailable or read-only',
  );
  await page.screenshot({
    path: testInfo.outputPath('sidebar-refusal-light.png'),
  });
  expect(prepared.size).toBe(0);
  await expect(
    page.getByRole('heading', { name: 'source', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('group', { name: 'Chat readonly', exact: true })
    .getByRole('button')
    .click();
  await expect(
    page.getByRole('heading', { name: 'readonly', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, 'sendCount'))).toBe(0);
});
