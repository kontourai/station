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
          useIntegrationsQuery=()=>query([]),useKnowledgeRootsQuery=()=>query([]);
      `,
      ConfigContext:
        'export const useConfig=()=>({defaultApprovalMode:"ask"});',
      ProjectsContext: `const project={id:'demo-id',slug:'demo',name:'Demo project',workingDirectory:'/home/developer/projects/station',description:'A workspace for product development'}; export const useScopedProjectQuery=()=>({data:project}); export const useScopedProjectChatDefaultsQuery=()=>({data:undefined});`,
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
createRoot(document.getElementById('root')).render(<NavigationProvider><DialogHistoryHostBoundary><div style={{height:'calc(100dvh - 72px)',display:'flex',flexDirection:'column',flexShrink:0,overflow:'hidden','--dock-bottom-clearance':'72px'}}><ProjectSettingsView slug="demo"/></div></DialogHistoryHostBoundary></NavigationProvider>);
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
      content: 'html,body,#root{height:100%;margin:0;overflow:hidden}',
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
