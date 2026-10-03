/** Production link and stack views; exact provider HTTP is the fixture boundary. */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, type Route } from '@playwright/test';
import { build } from 'esbuild';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let script = '';
let paneScript = '';
let stylesheet = '';
let paneStylesheet = '';
test.beforeAll(async () => {
  // The whole Diff pane body — git rows, Changes view, Pull requests view —
  // with fixture contexts, for the phone hit-target audit.
  const pane = await build({
    stdin: {
      resolveDir: ROOT,
      loader: 'tsx',
      contents: `
import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {CodingDiffPaneBody} from './src-ui/src/components/coding-layout/CodingDiffPaneBody';
import {setClientCredentialResolver} from '@kontourai/station-sdk/client';import {_setApiBase} from '@kontourai/station-sdk';
_setApiBase('http://station.test');
window.scope={apiBase:'http://station.test',authorityKey:'pane-owner',isCurrent:()=>true};
setClientCredentialResolver(()=>({origin:window.scope.apiBase,requestAuthority:window.scope}));
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><CodingDiffPaneBody projectSlug="repo" workingDir="/repo"/></QueryClientProvider>);
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
      'import.meta.env.MODE': '"production"',
      'import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE': 'false',
      'import.meta.env.PROD': 'true',
    },
    loader: { '.css': 'empty' },
    plugins: [
      {
        name: 'pane-fixtures',
        setup(b) {
          b.onResolve(
            {
              filter:
                /(ApiBaseContext|DeviceSettingsContext|ActiveChatsContext|NavigationContext)$/,
            },
            (a) => ({ path: a.path.split('/').at(-1), namespace: 'fixture' }),
          );
          b.onLoad({ filter: /.*/, namespace: 'fixture' }, (a) => ({
            loader: 'js',
            contents: (
              {
                ApiBaseContext:
                  'export const useHostRequestAuthorityScope=()=>window.scope;export const useApiBase=()=>({apiBase:window.scope.apiBase,credentialState:"ready"});',
                DeviceSettingsContext:
                  "export const useDeviceSettings=()=>({diffStyle:'unified',diffWrap:true});export const useDeviceSettingsActions=()=>({setDeviceSetting:()=>{}});",
                NavigationContext:
                  "export const useNavigation=selector=>selector({activeChat:'conv-1'});",
                ActiveChatsContext:
                  "const chats={'agent:1':{input:'',conversationId:'conv-1'}};export const activeChatsStore={getSnapshot:()=>chats,getChatKeyForExecutionSession:(id)=>chats[id]?id:Object.keys(chats).find((k)=>chats[k].conversationId===id)};export const useActiveChatActions=()=>({getDraft:()=>'',setDraft:()=>{},updateChat:()=>{}});",
              } as Record<string, string>
            )[a.path],
          }));
        },
      },
    ],
  });
  paneScript = pane.outputFiles[0].text;
  const paneStyles = await build({
    stdin: {
      contents:
        '@import "./src-ui/src/index.css";@import "./src-ui/src/components/editor-controls.css";@import "./src-ui/src/components/IconButton.css";@import "./src-ui/src/components/ActionOverflowMenu.css";@import "./src-ui/src/components/header/HeaderMenu.css";@import "./src-ui/src/components/chat/chat.css";@import "./src-ui/src/components/pull-requests/pull-request-chips.css";@import "./src-ui/src/components/pull-requests/PullRequestRow.css";@import "./src-ui/src/components/pull-requests/LinkPullRequestField.css";@import "./src-ui/src/components/coding-layout/CodingDiffPaneBody.css";@import "./src-ui/src/components/coding-layout/BranchToolbar.css";@import "./src-ui/src/components/coding-layout/DiffPanel.css";@import "./src-ui/src/components/coding-layout/PullRequestsPanel.css";@import "./src-ui/src/components/coding-layout/PullRequestDependencyStacks.css";',
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
  paneStylesheet = paneStyles.outputFiles[0].text;

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
const derived=[{...request('2','layer-2','layer-1'),source:'branch-derived',observedAt:'2026-09-12T00:00:00Z',status:{state:'current',title:'Change 2',pullRequestState:'OPEN',head:'2'.repeat(40)}},{provider:'github',host:'two.test',repository:{owner:'another',name:'repo'},ref:'17',source:'task-declared',observedAt:'2026-09-12T00:00:00Z',status:{state:'unavailable',reason:'Provider permission expired'}}];
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
  // The rows and icons carry 44px hit areas as pseudo-elements that reach
  // past their 28–30px boxes; a pane gives them its 12px gutter, and so does
  // this mount, or the bare <main> would report a horizontal overflow the
  // product never shows.
  const styles = await build({
    stdin: {
      contents:
        '@import "./src-ui/src/index.css";@import "./src-ui/src/components/IconButton.css";@import "./src-ui/src/components/ActionOverflowMenu.css";@import "./src-ui/src/components/header/HeaderMenu.css";@import "./src-ui/src/components/pull-requests/pull-request-chips.css";@import "./src-ui/src/components/pull-requests/PullRequestRow.css";@import "./src-ui/src/components/pull-requests/LinkPullRequestField.css";@import "./src-ui/src/components/pull-requests/ConversationPullRequestLinks.css";@import "./src-ui/src/components/coding-layout/PullRequestDependencyStacks.css";main{padding:0 12px;box-sizing:border-box}',
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
  await expect(page.getByText('two.test/another/repo #17')).toHaveCount(2);
  await expect(page.getByText('from branch', { exact: true })).toBeVisible();
  await expect(page.getByText('from a Task', { exact: true })).toBeVisible();
  await expect(page.getByText(/permission expired/).first()).toBeVisible();
  // The explicit link's Unlink is in its row menu; the Task-declared link
  // of the same number has none.
  const second = page
    .getByRole('listitem')
    .filter({ hasText: 'two.test/another/repo #17' })
    .filter({ hasText: 'linked' });
  await second
    .getByRole('button', { name: 'More actions for two.test/another/repo #17' })
    .click();
  await page.getByRole('menuitem', { name: 'Unlink' }).click();
  await expect(page.getByText('two.test/another/repo #17')).toHaveCount(1);
  await expect(page.getByText('from a Task', { exact: true })).toBeVisible();
  // No refresh or link button is labelled on the bar; the field is behind +.
  await expect(page.getByRole('button', { name: 'Refresh' })).toHaveText('');
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Link a pull request' }).click();
  await expect(
    page.getByRole('textbox', { name: 'Pull request' }),
  ).toBeVisible();
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

const PANE_PATCH = `diff --git a/src/server.ts b/src/server.ts
index 1111111..2222222 100644
--- a/src/server.ts
+++ b/src/server.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
`;
const panePullRequest = (over: Record<string, unknown> = {}) => ({
  provider: 'github',
  host: 'github.com',
  ref: '42',
  nativeId: '42',
  url: 'https://github.com/lantern/lantern/pull/42',
  repository: { owner: 'lantern', name: 'lantern' },
  title: 'Report uptime from the health endpoint',
  body: null,
  state: 'OPEN',
  author: { login: 'brian' },
  sourceBranch: 'feat/health-details',
  targetBranch: 'main',
  commits: 2,
  reviewStatus: 'CHANGES_REQUESTED',
  comments: 2,
  mergeability: 'mergeable',
  ...over,
});
const paneEnvelope = (data: unknown) => ({
  success: true,
  data: {
    available: true,
    effectiveCapabilities: {
      list: true,
      detail: true,
      open: true,
      comment: true,
      approve: true,
      merge: true,
      autoMerge: true,
    },
    effectiveMergeMethods: ['squash', 'merge'],
    mergeMethodsSource: 'repository',
    data,
  },
});

/** The Diff pane body at a width, with a dirty tree and two pull requests. */
async function mountPane(page: Page) {
  const json = (route: Route, body: unknown) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  await page.route(
    'http://station.test/api/**',
    rejectUnexpectedFixtureRequest,
  );
  await page.route('http://station.test/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="root" style="height:100vh;display:flex;flex-direction:column;overflow:hidden"></div></body></html>',
    }),
  );
  await page.route('**/api/coding/repos**', (r) =>
    json(r, {
      success: true,
      data: {
        workspace: '/repo',
        workspaceIsRepo: true,
        repos: [
          {
            root: '/repo',
            name: 'repo',
            relativePath: '.',
            branch: 'feat/health-details',
          },
        ],
      },
    }),
  );
  await page.route('**/api/coding/git/status**', (r) =>
    json(r, {
      success: true,
      data: {
        isRepo: true,
        branch: 'feat/health-details',
        changes: ['M src/server.ts'],
        staged: 0,
        unstaged: 1,
        untracked: 0,
        lastCommit: null,
        ahead: 2,
        behind: 0,
        remote: 'present',
      },
    }),
  );
  await page.route('**/api/coding/git/branches**', (r) =>
    json(r, {
      success: true,
      data: [
        { name: 'main', sha: 'aaaaaaa', date: '1 day ago', current: false },
        {
          name: 'feat/health-details',
          sha: 'bbbbbbb',
          date: 'now',
          current: true,
        },
      ],
    }),
  );
  await page.route('**/api/coding/git/diff**', (r) =>
    json(r, { success: true, data: PANE_PATCH }),
  );
  await page.route('**/api/projects/repo/diff-comments**', (r) =>
    json(r, { success: true, data: [] }),
  );
  await page.route('**/api/pull-requests/context**', (r) =>
    json(r, {
      success: true,
      data: {
        available: true,
        provider: 'github',
        host: 'github.com',
        repository: { owner: 'lantern', name: 'lantern' },
        branch: 'feat/health-details',
      },
    }),
  );
  await page.route(
    /\/api\/pull-requests\/github\/github\.com\/lantern\/lantern\?/,
    (r) =>
      json(
        r,
        paneEnvelope([
          panePullRequest(),
          panePullRequest({
            ref: '40',
            nativeId: '40',
            title: 'Dashboard subtitle',
            sourceBranch: 'feat/subtitle',
            reviewStatus: 'APPROVED',
            mergeability: 'conflicting',
            url: 'https://github.com/lantern/lantern/pull/40',
          }),
        ]),
      ),
  );
  await page.route('**/api/conversation-pull-requests/**', (r) =>
    json(r, {
      success: true,
      data: {
        conversationId: 'conv-1',
        observedAt: '2026-10-01T00:00:00Z',
        links: [],
      },
    }),
  );
  await page.goto('http://station.test/');
  await page.addStyleTag({ content: paneStylesheet });
  await page.addScriptTag({ content: paneScript });
  await expect(page.getByRole('button', { name: 'Wrap lines' })).toBeVisible();
}

/**
 * Every control's hit target, from its box and the 44px pseudo-element the
 * pane's sheets give a small control (centred on it): at least 44px both
 * ways, and no two overlapping. Light DOM only.
 */
const PANE_HIT_TARGET_AUDIT = `(() => {
  const root = document.getElementById('root');
  const interactive = Array.from(root.querySelectorAll(
    'button, input, textarea, summary, a[href], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]',
  )).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  });
  const zones = interactive.map((el) => {
    const r = el.getBoundingClientRect();
    let w = r.width, h = r.height;
    for (const pseudo of ['::before', '::after']) {
      const cs = getComputedStyle(el, pseudo);
      if (cs.content !== 'none' && cs.position === 'absolute') {
        const pw = parseFloat(cs.width), ph = parseFloat(cs.height);
        if (pw > w) w = pw;
        if (ph > h) h = ph;
      }
    }
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const name = el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 30) || el.tagName;
    return { name, w, h, l: cx - w / 2, r: cx + w / 2, t: cy - h / 2, b: cy + h / 2 };
  });
  const small = zones.filter((z) => z.w < 43.5 || z.h < 43.5).map((z) => z.name + ' ' + Math.round(z.w) + 'x' + Math.round(z.h));
  const overlaps = [];
  for (let i = 0; i < zones.length; i += 1) for (let j = i + 1; j < zones.length; j += 1) {
    const a = zones[i], b = zones[j];
    const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l), oy = Math.min(a.b, b.b) - Math.max(a.t, b.t);
    if (ox > 1 && oy > 1) overlaps.push(a.name + ' / ' + b.name + ' ' + Math.round(ox) + 'x' + Math.round(oy));
  }
  return { count: zones.length, small, overlaps };
})()`;

test('at phone width every Diff pane control has a 44px target of its own, in both views', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountPane(page);
  type Audit = { count: number; small: string[]; overlaps: string[] };
  // Changes: git rows, the branch line, the toolbar, the file toggles.
  await expect(
    page.getByRole('button', { name: /Open pull request #42/ }),
  ).toBeVisible();
  const changes = (await page.evaluate(PANE_HIT_TARGET_AUDIT)) as Audit;
  expect(changes.count).toBeGreaterThan(8);
  expect(changes.small).toEqual([]);
  expect(changes.overlaps).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('pane-changes-390.png') });
  // Pull requests: the filter, the icons, the open link field, the rows.
  await page.getByRole('button', { name: 'Pull requests' }).click();
  await expect(
    page.getByRole('button', { name: 'Dashboard subtitle' }),
  ).toBeVisible();
  // The commit row belongs to Changes alone.
  await expect(page.getByLabel('Commit message')).toHaveCount(0);
  await page.getByRole('button', { name: 'Link a pull request' }).click();
  await expect(
    page.getByRole('textbox', { name: 'Pull request' }),
  ).toBeVisible();
  const pulls = (await page.evaluate(PANE_HIT_TARGET_AUDIT)) as Audit;
  expect(pulls.count).toBeGreaterThan(8);
  expect(pulls.small).toEqual([]);
  expect(pulls.overlaps).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('pane-pulls-390.png') });
});
