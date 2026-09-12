/** Production link and stack views; exact provider HTTP is the fixture boundary. */
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
import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {ConversationPullRequestLinks} from './src-ui/src/components/pull-requests/ConversationPullRequestLinks';
import {PullRequestDependencyStacks} from './src-ui/src/components/coding-layout/PullRequestDependencyStacks';
import {setClientCredentialResolver} from '@kontourai/station-sdk/client';
window.scope={apiBase:'http://station.test',authorityKey:'link-owner',isCurrent:()=>true};
setClientCredentialResolver(()=>({origin:window.scope.apiBase,requestAuthority:window.scope}));
const request=(ref,sourceBranch,targetBranch)=>({provider:'github',host:'forge.test',repository:{owner:'team',name:'repo'},ref,nativeId:ref,url:'https://forge.test/team/repo/pull/'+ref,title:'Change '+ref,body:null,state:ref==='3'?'DRAFT':'OPEN',author:{login:'author'},sourceBranch,targetBranch,headSha:ref.repeat(40),commits:1,reviewStatus:'NONE',comments:0,mergeability:'unknown'});
const derived=[{...request('2','layer-2','layer-1'),source:'branch-derived',observedAt:'2026-09-12T00:00:00Z',status:{state:'current',title:'Change 2',pullRequestState:'OPEN',head:'2'.repeat(40)}},{...request('9','task','main'),source:'task-declared',observedAt:'2026-09-12T00:00:00Z',status:{state:'unavailable',reason:'Provider permission expired'}}];
function App(){return <main><ConversationPullRequestLinks conversationId="conversation-1" suggested={{provider:'github',host:'forge.test',repository:{owner:'team',name:'repo'}}} derived={derived}/><PullRequestDependencyStacks pullRequests={[request('3','layer-3','layer-2'),request('1','layer-1','main'),request('2','layer-2','layer-1')]} observedAt="2026-09-12T00:00:00Z" refreshing={false} onRefresh={()=>{window.refreshed=true;}} onOpen={pr=>{window.opened=pr.ref;}}/></main>}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><App/></QueryClientProvider>);
`,
    },
    bundle: true,
    write: false,
    jsx: 'automatic',
    format: 'iife',
    platform: 'browser',
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env.DEV': 'false',
    },
    loader: { '.css': 'empty' },
    plugins: [
      {
        name: 'current-station',
        setup(builder) {
          builder.onResolve({ filter: /ApiBaseContext$/ }, () => ({
            path: 'authority',
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            loader: 'js',
            contents:
              'export const useHostRequestAuthorityScope=()=>window.scope;',
          }));
        },
      },
    ],
  });
  script = result.outputFiles[0].text;
  const styles = await build({
    stdin: {
      contents:
        '@import "./src-ui/src/index.css";@import "./src-ui/src/components/pull-requests/ConversationPullRequestLinks.css";@import "./src-ui/src/components/coding-layout/PullRequestDependencyStacks.css";',
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
  const explicit = [
    {
      provider: 'github',
      host: 'one.test',
      repository: { owner: 'team', name: 'repo' },
      ref: '17',
      source: 'explicit',
      linkedAt: '2026-09-12T00:00:00Z',
      linkedBy: 'operator',
      observedAt: '2026-09-12T00:00:00Z',
      status: {
        state: 'current',
        title: 'First exact link',
        pullRequestState: 'OPEN',
        head: 'a'.repeat(40),
      },
    },
    {
      provider: 'github',
      host: 'two.test',
      repository: { owner: 'another', name: 'repo' },
      ref: '17',
      source: 'explicit',
      linkedAt: '2026-09-12T00:00:00Z',
      linkedBy: 'operator',
      observedAt: '2026-09-12T00:00:00Z',
      status: {
        state: 'unavailable',
        reason: 'Provider permission expired',
      },
    },
  ];
  const mutations: Array<{ method: string; body: unknown }> = [];
  await page.route(
    'http://station.test/api/**',
    rejectUnexpectedFixtureRequest,
  );
  await page.route('http://station.test/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>',
    }),
  );
  await page.route(
    'http://station.test/api/conversation-pull-requests/conversation-1',
    (route) => {
      if (route.request().method() === 'GET')
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              conversationId: 'conversation-1',
              observedAt: '2026-09-12T00:00:00Z',
              links: explicit,
            },
          }),
        });
      const body = route.request().postDataJSON();
      mutations.push({ method: route.request().method(), body });
      if (route.request().method() === 'DELETE')
        explicit.splice(
          explicit.findIndex(
            (link) =>
              link.host === body.host &&
              link.repository.owner === body.repository.owner &&
              link.ref === body.ref,
          ),
          1,
        );
      return route.fulfill({
        status: route.request().method() === 'POST' ? 201 : 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { conversationId: 'conversation-1' },
        }),
      });
    },
  );
  await page.goto('http://station.test/');
  await page.addStyleTag({ content: stylesheet });
  await page.addScriptTag({ content: script });
  await expect(
    page.getByRole('heading', { name: 'Linked pull requests' }),
  ).toBeVisible();
  return mutations;
}

test('keeps same-number links distinct and shows explicit, derived and Task provenance', async ({
  page,
}, testInfo) => {
  const mutations = await mount(page);
  await expect(page.getByText('one.test/team/repo #17')).toBeVisible();
  await expect(page.getByText('two.test/another/repo #17')).toBeVisible();
  await expect(page.getByText(/Derived from the current branch/)).toBeVisible();
  await expect(page.getByText(/Declared by a Task/)).toBeVisible();
  await expect(page.getByText(/permission expired/).first()).toBeVisible();
  const second = page
    .getByText('two.test/another/repo #17')
    .locator('..')
    .locator('..');
  await second.getByRole('button', { name: 'Unlink' }).click();
  await expect(page.getByText('two.test/another/repo #17')).toHaveCount(0);
  expect(mutations).toMatchObject([
    {
      method: 'DELETE',
      body: {
        host: 'two.test',
        repository: { owner: 'another', name: 'repo' },
        ref: '17',
      },
    },
  ]);
  await page.screenshot({
    path: testInfo.outputPath('conversation-links.png'),
  });
});

test('orders a provider branch stack in a narrow pane without changing checkout', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page);
  const stack = page.getByRole('region', { name: 'Pull request stacks' });
  await expect(
    stack.getByRole('button', { name: /#1 Change 1/ }),
  ).toBeVisible();
  const labels = await stack.locator('ol li button').allTextContents();
  expect(labels).toEqual(['#1 Change 1', '#2 Change 2', '#3 Change 3']);
  await stack.getByRole('button', { name: /#2 Change 2/ }).click();
  expect(await page.evaluate(() => Reflect.get(window, 'opened'))).toBe('2');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: testInfo.outputPath('dependency-stack-phone.png'),
  });
});
