/** Production review panel, diff renderer, SDK and confirmation; provider HTTP is the fixture boundary. */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PullRequestReviewSnapshot } from '@kontourai/station-contracts/pull-request-provider';
import { expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let script = '',
  stylesheet = '';
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: ROOT,
      loader: 'tsx',
      contents: `
 import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
 import {PullRequestReviewPanel} from './src-ui/src/components/coding-layout/PullRequestReviewPanel';
 import {setClientCredentialResolver} from '@kontourai/station-sdk/client';
 window.scope={apiBase:'http://station.test',authorityKey:'review-owner',isCurrent:()=>true};
 window.chatDraft='Existing chat draft';
 setClientCredentialResolver(()=>({origin:window.scope.apiBase,requestAuthority:window.scope}));
 const target={provider:new URL(location.href).searchParams.get('forge'),host:'forge.test',owner:'team',repository:'repo',ref:'17',project:'project'};
 createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><PullRequestReviewPanel target={target} onBack={()=>{document.title='Back to list';}}/></QueryClientProvider>);
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
        name: 'host-and-view-settings',
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
                  'export const useHostRequestAuthorityScope=()=>window.scope;export const useApiBase=()=>({apiBase:window.scope.apiBase});',
                DeviceSettingsContext:
                  "export const useDeviceSettings=()=>({diffStyle:'unified',diffWrap:true});export const useDeviceSettingsActions=()=>({setDeviceSetting:()=>{}});",
                NavigationContext:
                  "export const useNavigation=selector=>selector({activeChat:'chat-1'});",
                ActiveChatsContext:
                  "const state={input:'Existing chat draft'};export const activeChatsStore={getSnapshot:()=>({'chat-1':state})};export const useActiveChatActions=()=>({getDraft:()=>window.chatDraft,setDraft:(_id,value)=>{window.chatDraft=value;state.input=value;},updateChat:(_id,value)=>Object.assign(state,value)});",
              } as Record<string, string>
            )[a.path],
          }));
        },
      },
    ],
  });
  script = result.outputFiles[0].text;
  const styles = await build({
    stdin: {
      contents:
        '@import "./src-ui/src/index.css";@import "./src-ui/src/components/coding-layout/PullRequestReviewPanel.css";@import "./src-ui/src/components/coding-layout/DiffPanel.css";@import "./src-ui/src/components/chat/chat.css";',
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

const HEAD = 'a'.repeat(40),
  NEXT = 'c'.repeat(40);
const caps = {
  list: true,
  detail: true,
  open: true,
  comment: true,
  approve: true,
  merge: true,
  autoMerge: true,
};
async function mount(page: Page, forge: 'github' | 'gitlab', lost = false) {
  let head = HEAD,
    state = 'OPEN';
  let first = true;
  const writes: Array<Record<string, unknown>> = [];
  const discussion: PullRequestReviewSnapshot['discussion'] = [];
  await page.route(
    'http://station.test/api/**',
    rejectUnexpectedFixtureRequest,
  );
  await page.route('http://station.test/?*', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>',
    }),
  );
  const envelope = (data: unknown) => ({
    success: true,
    data: {
      available: true,
      effectiveCapabilities: caps,
      effectiveMergeMethods: ['merge', 'squash'],
      mergeMethodsSource: 'repository',
      data,
    },
  });
  await page.route(
    /http:\/\/station.test\/api\/pull-requests\/[^/]+\/forge.test\/team\/repo\/17\/review\?/,
    (r) => {
      if (r.request().method() === 'GET') {
        const data: PullRequestReviewSnapshot = {
          pullRequest: {
            provider: forge,
            host: 'forge.test',
            repository: { owner: 'team', name: 'repo' },
            ref: '17',
            nativeId: '17',
            url: 'https://forge.test/team/repo/pull/17',
            title: 'Handle an empty selection',
            body: 'Preserve the existing document.',
            state,
            author: { login: 'author' },
            sourceBranch: 'fix',
            targetBranch: 'main',
            commits: 1,
            reviewStatus: 'NONE',
            comments: discussion.length,
            mergeability: 'mergeable',
          },
          headSha: head,
          baseSha: 'b'.repeat(40),
          observedAt: '2026-09-10T00:00:00Z',
          diff: {
            state: 'available',
            completeness: 'provider-output',
            patch:
              'diff --git a/answer.ts b/answer.ts\n--- a/answer.ts\n+++ b/answer.ts\n@@ -1 +1 @@\n-const answer = 1;\n+const answer = 2;\n',
          },
          discussion: [...discussion],
          discussionPartial: false,
        };
        return r.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(envelope(data)),
        });
      }
      const input = r.request().postDataJSON();
      writes.push(input);
      if (input.expectedHeadSha !== head)
        return r.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(
            envelope({
              status: 'refused',
              reason:
                'The pull request head changed. Refresh and review the new revision.',
            }),
          ),
        });
      if (input.action === 'comment')
        discussion.push({
          id: String(writes.length),
          author: 'operator',
          body: input.body,
          kind: 'comment',
          createdAt: '2026-09-10T00:01:00Z',
        });
      if (lost && first) {
        first = false;
        return r.abort('connectionreset');
      }
      return r.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(
          envelope({
            status: 'confirmed',
            nativeId: 'review-1',
            actor: 'operator',
            ...(forge === 'github' || input.action === 'approve'
              ? { headSha: head }
              : {}),
          }),
        ),
      });
    },
  );
  await page.route(
    /http:\/\/station.test\/api\/pull-requests\/[^/]+\/forge.test\/team\/repo\/17\/merge\?/,
    (r) => {
      const input = r.request().postDataJSON();
      writes.push(input);
      if (input.expectedHeadSha !== head)
        return r.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(
            envelope({ status: 'refused', reason: 'Head changed' }),
          ),
        });
      state = 'MERGED';
      return r.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(envelope({ status: 'merged' })),
      });
    },
  );
  await page.goto(`http://station.test/?forge=${forge}`);
  await page.addStyleTag({ content: stylesheet });
  await page.addScriptTag({ content: script });
  await expect(
    page.getByRole('heading', { name: 'Handle an empty selection' }),
  ).toBeVisible();
  return {
    writes,
    changeHead: () => {
      head = NEXT;
    },
  };
}
test('review diff, comment, approve and merge the exact displayed head', async ({
  page,
}, testInfo) => {
  const fixture = await mount(page, 'github');
  await expect(
    page.getByText('answer.ts', { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText('const answer = 2;', { exact: false }).first(),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Add review context to open chat' })
    .click();
  await expect(page.getByRole('status')).toContainText(
    'Added review context to the open chat without sending',
  );
  expect(await page.evaluate(() => Reflect.get(window, 'chatDraft'))).toBe(
    `Existing chat draft\n\nReview forge.test/team/repo #17\nHead: ${HEAD}\nSource: https://forge.test/team/repo/pull/17`,
  );
  await page
    .getByRole('textbox', { name: 'Comment', exact: true })
    .fill('Reviewed the empty selection.');
  await page.getByRole('button', { name: 'Post comment', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Post review comment' });
  await expect(dialog).toContainText(HEAD);
  await dialog
    .getByRole('button', { name: 'Post comment', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Comment', exact: true }),
  ).toHaveValue('');
  await page
    .getByRole('button', { name: 'Approve this head', exact: true })
    .click();
  dialog = page.getByRole('dialog', { name: 'Approve inspected head' });
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Confirmed by operator' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Merge inspected head', exact: true })
    .click();
  dialog = page.getByRole('dialog', { name: 'Merge inspected head' });
  await expect(dialog).toContainText(HEAD);
  await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(
    page.getByText('The provider reports this pull request merged.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(fixture.writes.map((x) => x.expectedHeadSha)).toEqual([
    HEAD,
    HEAD,
    HEAD,
  ]);
  await page.screenshot({ path: testInfo.outputPath('review-merged.png') });
});
test('a lost comment acknowledgement retains the draft and a changed head is refused', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mount(page, 'gitlab', true);
  await page.evaluate(() =>
    document.documentElement.setAttribute('data-theme', 'light'),
  );
  await page
    .getByRole('textbox', { name: 'Comment', exact: true })
    .fill('Keep this draft.');
  await page.getByRole('button', { name: 'Post comment', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Post review comment' })
    .getByRole('button', { name: 'Post comment', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Comment', exact: true }),
  ).toHaveValue('Keep this draft.');
  await expect(
    page.getByRole('button', { name: 'Post comment', exact: true }),
  ).toBeDisabled();
  expect(fixture.writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByText('Keep this draft.', { exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Prepare another submission', exact: true })
    .click();
  fixture.changeHead();
  await page
    .getByRole('button', { name: 'Approve this head', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Approve inspected head' })
    .getByRole('button', { name: 'Approve', exact: true })
    .click();
  await expect(
    page.getByText(
      'The pull request head changed. Refresh and review the new revision.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Comment', exact: true }),
  ).toHaveValue('Keep this draft.');
  await page.screenshot({
    path: testInfo.outputPath('review-refused-phone.png'),
  });
});
