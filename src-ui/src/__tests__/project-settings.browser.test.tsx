import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'esbuild';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// Query fixtures exercise production controls and layout, without claiming API persistence.
const fixtures: Plugin = {
  name: 'project-settings-data',
  setup(builder) {
    const modules: Record<string, string> = {
      '@kontourai/station-sdk': `
        export const telemetry={track:()=>{}}; export const layoutCatalogErrorReason=()=>undefined;
        const project={id:'demo-id',slug:'demo',name:'Demo project',workingDirectory:'/home/developer/projects/station',description:'A workspace for product development'};
        const agents=[{slug:'builder',name:'Builder'},{slug:'reviewer',name:'Reviewer'}];
        const query=data=>({data,isLoading:false,isError:false,refetch:()=>{}});
        const mutation=()=>({isPending:false,isError:false,mutate:()=>{},mutateAsync:async()=>project});
        export const useUpdateProjectMutation=mutation,useDeleteProjectMutation=mutation,
          useKnowledgeBulkDeleteMutation=mutation,useKnowledgeDeleteMutation=mutation,
          useKnowledgeSaveMutation=mutation,useKnowledgeScanMutation=mutation,
          useMigratePreIndexKnowledgeMutation=mutation,useApplyProjectLayoutMutation=mutation,
          useDeleteProjectLayoutMutation=mutation;
        export const useProjectIconCandidatesQuery=()=>query([]),useModelConnectionsQuery=()=>query([]),
          useEngineConnectionsQuery=()=>query([]),useAgentsQuery=()=>query(agents),
          useProjectLayoutsQuery=()=>query([{id:'code',slug:'code',name:'Coding',type:'coding'}]),
          useAvailableProjectLayoutsQuery=()=>query([]),useKnowledgeDocsQuery=()=>query([{id:'readme',filename:'README.md',chunkCount:4}]),
          useKnowledgeStatusQuery=()=>query({totalChunks:4,documentCount:1}),
          useIntegrationsQuery=()=>query([]),useKnowledgeRootsQuery=()=>query([]),
          useFeaturePreviewsQuery=()=>query([{id:'stale-project-checkout',enabled:true}]);
      `,
      ConfigContext:
        'export const useConfig=()=>({defaultApprovalMode:"ask"});',
      ApiBaseContext:
        'export const useHostRequestAuthorityScope=()=>({apiBase:"http://station.test",authorityKey:"fixture"});',
      ProjectsContext: `const project={id:'demo-id',slug:'demo',name:'Demo project',workingDirectory:'/home/developer/projects/station',description:'A workspace for product development'}; export const useScopedProjectQuery=()=>({data:project}); export const useScopedProjectChatDefaultsQuery=()=>({data:undefined}); export const useScopedProjectCheckoutFreshnessQuery=()=>({data:{version:'station.project-checkout-freshness/v1',status:'stale',staleBecause:['commits'],thresholds:{commits:50,days:3},branch:'main',upstream:'origin/main',behind:183,ahead:0,upstreamFetchedAt:new Date(Date.now()-2*86400000).toISOString(),updateCommand:'git -C /home/developer/projects/station pull --ff-only',checkedAt:new Date().toISOString()},error:null,isFetching:false,refetch:async()=>{}});`,
      AgentsContext: 'export const useAgents=()=>[];',
      useShowSurface: 'export const useShowSurface=()=>()=>{};',
      useKeyboardShortcut: 'export const useKeyboardShortcut=()=>{};',
      PathAutocomplete: `import React from 'react';export const PathAutocomplete=({id,value,onChange,className})=><input id={id} className={className} value={value} onChange={e=>onChange(e.target.value)}/>;`,
      ModelSelector: `import React from 'react';export const ModelSelector=({value,disabled})=><input aria-label="Default model" value={value} disabled={disabled} readOnly/>;`,
      EnvironmentPicker: `import React from 'react';export const EnvironmentPicker=()=> <p>Current Station</p>;`,
      ProjectSourcesSection: `import React from 'react';export const ProjectSourcesSection=()=> <section id="section-resources" className="page-section"><h2>Sources</h2><p>Source administration is covered by its own tests.</p></section>;`,
      AccessSection: `import React from 'react';export const AccessSection=()=> <section id="section-access" className="page-section"><h2>People and access</h2></section>;`,
    };
    builder.onResolve({ filter: /./ }, (args) => {
      const key =
        args.path in modules ? args.path : args.path.split('/').at(-1)!;
      return key in modules
        ? { path: key, namespace: 'settings-fixtures' }
        : undefined;
    });
    builder.onLoad(
      { filter: /.*/, namespace: 'settings-fixtures' },
      (args) => ({
        contents: modules[args.path],
        loader: 'tsx',
        resolveDir: process.cwd(),
      }),
    );
  },
};

const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {NavigationProvider} from './src-ui/src/contexts/NavigationContext';
import {DialogHistoryHostBoundary} from './src-ui/src/components/DialogHistoryHost';
import {ProjectSettingsView} from './src-ui/src/views/ProjectSettingsView';
createRoot(document.getElementById('root')).render(<NavigationProvider><DialogHistoryHostBoundary><div style={{position:'fixed',inset:0,height:'calc(100dvh - 72px)',display:'flex',flexDirection:'column',overflow:'visible','--dock-bottom-clearance':'72px'}}><ProjectSettingsView slug="demo"/></div></DialogHistoryHostBoundary></NavigationProvider>);
`;

test('project settings remain usable above the dock at phone and desktop widths in both themes', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(fixture, [
    fixtures,
  ]);
  page.setDefaultTimeout(5000);
  try {
    const baseStyles = await page.addStyleTag({
      content:
        resolveCssImports(
          resolve(import.meta.dirname, '../components/editor-controls.css'),
        ) + resolveCssImports(resolve(import.meta.dirname, '../index.css')),
    });
    await baseStyles.evaluate((element) => document.head.prepend(element));
    await page.addStyleTag({
      content:
        'html,body,#root{height:100%;margin:0;overflow:hidden}*,*::before,*::after{box-sizing:border-box}',
    });
    const out = resolve('.kontourai/project-settings-audit');
    mkdirSync(out, { recursive: true });
    for (const theme of ['dark', 'light']) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      );
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page
          .getByRole('link', { name: 'Workspace', exact: true })
          .click();
        await page
          .locator('#section-workspace')
          .evaluate((element) => element.focus({ preventScroll: true }));
        await page.getByRole('textbox', { name: 'Name *' }).waitFor();
        // Before any animation settles: the previous pass ended on Danger
        // zone, and a fading fill read as a second selected tab.
        expect(
          await page
            .getByRole('link', { name: 'Danger zone', exact: true })
            .evaluate((element) => getComputedStyle(element).backgroundColor),
        ).toBe('rgba(0, 0, 0, 0)');
        // The stale checkout warning renders in the Workspace section.
        await page
          .locator('#section-workspace')
          .getByTestId('project-checkout-stale')
          .waitFor();
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        await page.locator('.project-settings__body').evaluate((element) => {
          element.scrollTop = 0;
          for (
            let parent = element.parentElement;
            parent;
            parent = parent.parentElement
          )
            parent.scrollTop = 0;
        });
        await page.mouse.move(0, 0);
        await page.evaluate(() =>
          Promise.all(
            document.getAnimations().map((animation) => animation.finished),
          ),
        );
        const nav = page.getByRole('navigation', {
          name: 'Project settings sections',
        });
        expect(await nav.locator('[aria-current="location"]').count()).toBe(1);
        expect(
          await nav
            .getByRole('link', { name: 'Workspace', exact: true })
            .getAttribute('aria-current'),
        ).toBe('location');
        const leafLines = await page
          .locator('.project-settings__path-pill code')
          .last()
          .evaluate((element) => {
            const walker = document.createTreeWalker(
              element,
              NodeFilter.SHOW_TEXT,
            );
            let last: Node | null = null;
            while (walker.nextNode()) last = walker.currentNode;
            if (!last?.textContent?.endsWith('station'))
              throw new Error('Expected fixture path leaf');
            const range = document.createRange();
            range.setStart(last, last.textContent.length - 7);
            range.setEnd(last, last.textContent.length);
            return new Set(Array.from(range.getClientRects(), (rect) => rect.y))
              .size;
          });
        expect(leafLines).toBe(1);
        await page.screenshot({ path: `${out}/${width}-${theme}.png` });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        const icon = await page
          .getByRole('button', { name: 'Choose project icon' })
          .boundingBox();
        expect(icon!.width).toBeGreaterThanOrEqual(44);
        expect(icon!.height).toBeGreaterThanOrEqual(44);
        await page.getByRole('link', { name: 'Agents', exact: true }).click();
        const agent = page.getByRole('checkbox', {
          name: /Make Builder available/,
        });
        await page.locator('label[for="project-agent-builder"]').click();
        expect(await agent.isChecked()).toBe(false);
        await page.locator('label[for="project-agent-builder"]').click();
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await page.screenshot({ path: `${out}/agents-${width}-${theme}.png` });
        await page
          .getByRole('link', { name: 'Danger zone', exact: true })
          .click();
        const remove = page.getByRole('button', {
          name: 'Delete Project',
          exact: true,
        });
        await page.locator('.project-settings__body').evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        const bounds = await remove.boundingBox();
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900 - 72);
        await page.screenshot({ path: `${out}/danger-${width}-${theme}.png` });
        await remove.click();
        await page.getByRole('dialog', { name: 'Delete Project' }).waitFor();
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      }
    }
    expect(errors).toEqual([]);
  } catch (error) {
    await page.screenshot({
      path: resolve('.kontourai/project-settings-audit/failure.png'),
    });
    throw error;
  } finally {
    await browser.close();
  }
}, 60000);

test('account conflict recovery is legible at phone and desktop widths in both themes', async () => {
  const accountFixture = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { AccountIdentityConflict } from './src-ui/src/components/AccountIdentityConflict';
    createRoot(document.getElementById('root')).render(<main style={{padding:'24px'}}><AccountIdentityConflict apiBase="http://station.test" onRecovered={()=>{}} /></main>);
  `;
  const accountMocks: Plugin = {
    name: 'account-conflict-fixture',
    setup(builder) {
      builder.onResolve(
        {
          filter: /^@kontourai\/station-sdk\/(account-authentication|client)$/,
        },
        (args) => ({ path: args.path, namespace: 'account-fixture' }),
      );
      builder.onLoad(
        { filter: /.*/, namespace: 'account-fixture' },
        (args) => ({
          loader: 'js',
          contents: args.path.endsWith('/client')
            ? 'export class StationHttpError extends Error {}; export const envelopeReasons = () => [];'
            : 'export async function runAccountOperation() {}',
        }),
      );
    },
  };
  const { browser, page, errors } = await scrollBrowserFixture(accountFixture, [
    accountMocks,
  ]);
  try {
    await page.addStyleTag({
      content: resolveCssImports(resolve(import.meta.dirname, '../index.css')),
    });
    const out = resolve('.kontourai/account-conflict-visual');
    mkdirSync(out, { recursive: true });
    for (const theme of ['dark', 'light']) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      );
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const button = page.getByRole('button', {
          name: 'Sign out of account',
        });
        await button.evaluate(async (element) => {
          await Promise.all(
            element
              .getAnimations()
              .map((animation) => animation.finished.catch(() => undefined)),
          );
        });
        expect(await button.isVisible()).toBe(true);
        expect(
          await page
            .getByText(
              'This browser is signed in to a Station account. Sign out of that account to use owner controls.',
            )
            .isVisible(),
        ).toBe(true);
        await page.screenshot({ path: `${out}/${theme}-${width}.png` });
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
