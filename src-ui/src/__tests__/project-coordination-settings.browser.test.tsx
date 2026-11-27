/**
 * #5062/#5065/#5068: Project settings › Brief, Memory, Models and effort and
 * Usage, and the Project header's goal, mounted from their production owners
 * in Chromium at 390 and 1440 pixels in both themes. Memory and usage read
 * through the real SDK clients against routed fixture responses. Each render
 * is saved under `.surface/project-coordination/` for review.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import type { Plugin } from 'esbuild';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

const fixture = `
  import React, {useState} from 'react';
  import {createRoot} from 'react-dom/client';
  import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
  import {BriefSection} from './src-ui/src/views/project-settings/BriefSection';
  import {MemorySection} from './src-ui/src/views/project-settings/MemorySection';
  import {ProjectModelsSection} from './src-ui/src/views/project-settings/ProjectModelsSection';
  import {ProjectUsageSection} from './src-ui/src/views/project-settings/ProjectUsageSection';
  import {ProjectPageHeader} from './src-ui/src/views/project-page/ProjectPageHeader';
  import {buildProjectForm} from './src-ui/src/views/project-settings/utils';
  import {setClientCredentialResolver} from '@kontourai/station-sdk/client';
  import './src-ui/src/components/editor-controls.css';
  import './src-ui/src/views/page-layout.css';
  import './src-ui/src/views/editor-layout.css';
  import './src-ui/src/views/ProjectSettingsView.css';
  import './src-ui/src/views/ProjectPage.css';
  window.fixtureRequestScope = {apiBase:'http://station.test', authorityKey:'fixture', isCurrent:()=>true};
  // As the app shell does: the ambient connection names the authority a
  // scoped read is checked against.
  setClientCredentialResolver(() => ({origin:'http://station.test', requestAuthority: window.fixtureRequestScope}));
  const project = {
    id:'p', slug:'export', name:'Export redesign', createdAt:'', updatedAt:'',
    goal:'Ship the new export flow by Friday',
    instructions:'This Project rebuilds CSV and PDF export.\\n\\nRun npm test before saying done.\\n\\nAsk before changing billing.',
    coordinatorEffort:'medium', taskProviderId:'claude', taskModel:'claude-sonnet-5-5', taskEffort:'low',
  };
  function Form({section}) {
    const [form, setForm] = useState(buildProjectForm(project));
    const setField = (key, value) => setForm((current) => ({...current, [key]: value}));
    return section === 'brief'
      ? <BriefSection form={form} setField={setField}/>
      : <ProjectModelsSection form={form} setField={setField}/>;
  }
  let root;
  window.mount = (section) => {
    root?.unmount();
    document.body.dataset.theme = document.documentElement.dataset.theme;
    root = createRoot(document.getElementById('root'));
    const body = section === 'header'
      ? <div className="project-page project-page--space"><div className="project-page__inner"><ProjectPageHeader project={project} goal={project.goal} gitStatus={null} navigateToSettings={()=>{}}/></div></div>
      : <div className="page page--full"><div className="section-nav-rail__body project-settings__body">
          {section === 'memory' ? <MemorySection slug="export"/>
            : section === 'usage' ? <ProjectUsageSection slug="export"/>
            : <Form section={section}/>}
        </div></div>;
    root.render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>{body}</QueryClientProvider>);
  };
`;

const scopeStub: Plugin = {
  name: 'project-coordination-scope',
  setup(build) {
    build.onResolve({ filter: /ApiBaseContext$/ }, async (args) => {
      if (args.pluginData?.real) return;
      const real = await build.resolve(args.path, {
        resolveDir: args.resolveDir,
        kind: args.kind,
        pluginData: { real: true },
      });
      return { path: real.path, namespace: 'project-coordination-scope' };
    });
    build.onLoad(
      { filter: /.*/, namespace: 'project-coordination-scope' },
      (args) => ({
        contents: `export * from ${JSON.stringify(args.path)}; export const useHostRequestAuthorityScope = () => window.fixtureRequestScope ?? null;`,
        loader: 'tsx',
        resolveDir: dirname(args.path),
      }),
    );
  },
};

const author = { kind: 'agent', label: 'coder', sessionId: 's1' };
const NOTES = [
  'The release moved to Friday',
  'PDF export was dropped from v1',
  'Check with Dana before touching billing',
].map((title, index) => ({
  id: `note${index}`,
  title,
  createdAt: '2026-11-15T10:00:00.000Z',
  updatedAt: `2026-11-1${6 - index}T10:00:00.000Z`,
  createdBy: author,
  updatedBy: index === 2 ? { kind: 'person', label: 'Project owner' } : author,
}));

function usageRow(
  key: string,
  fields: Record<string, unknown>,
  tokens: [number, number],
) {
  return {
    key,
    stationId: 'local',
    provider: 'claude',
    inputTokens: tokens[0],
    outputTokens: tokens[1],
    pricingStatus: 'priced',
    estimatedCost: {
      amount: (tokens[0] + tokens[1]) / 100_000,
      currency: 'USD',
      pricingSnapshotId: 'snap',
    },
    receiptCount: 3,
    ...fields,
  };
}

async function routeApi(page: Page) {
  await page.route('http://station.test/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/projects/export/memory')
      return route.fulfill({
        json: { success: true, data: { projectSlug: 'export', notes: NOTES } },
      });
    if (
      url.pathname === '/api/analytics/usage-rollup' &&
      url.searchParams.get('projectSlug') === 'export' &&
      url.searchParams.get('localOnly') === '1'
    ) {
      const byTask = url.searchParams.get('groupBy') === 'task';
      return route.fulfill({
        json: {
          success: true,
          data: {
            window: { from: '2026-10-19', to: '2026-11-17' },
            coverage: [
              {
                stationId: 'local',
                state: 'complete',
                window: { from: '2026-10-19', to: '2026-11-17' },
              },
            ],
            receipts: [],
            rows: byTask
              ? [
                  usageRow(
                    'task:3f2c',
                    { taskId: '3f2c9a1e-csv' },
                    [412_500, 31_200],
                  ),
                  usageRow('task:unattributed', {}, [182_000, 9_400]),
                  usageRow(
                    'task:8b17',
                    { taskId: '8b17d044-pdf' },
                    [96_300, 7_800],
                  ),
                ]
              : [
                  usageRow(
                    'model:opus',
                    { model: 'claude-opus-5-5' },
                    [182_000, 9_400],
                  ),
                  usageRow(
                    'model:sonnet',
                    { model: 'claude-sonnet-5-5' },
                    [508_800, 39_000],
                  ),
                ],
          },
        },
      });
    }
    return route.fulfill({ status: 404, json: { success: false } });
  });
}

const SECTIONS = ['header', 'brief', 'memory', 'models', 'usage'] as const;

test('the Project brief, memory, models and usage render at 390 and 1440 in both themes', async () => {
  const { page, browser, errors } = await scrollBrowserFixture(fixture, [
    scopeStub,
  ]);
  try {
    await page.addStyleTag({
      content: resolveCssImports(resolve('src-ui/src/index.css')),
    });
    await routeApi(page);
    const out = resolve('.surface/project-coordination');
    await mkdir(out, { recursive: true });
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate((selected) => {
        document.documentElement.dataset.theme = selected;
      }, theme);
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        for (const section of SECTIONS) {
          await page.evaluate((selected) => {
            (window as unknown as { mount: (s: string) => void }).mount(
              selected,
            );
          }, section);
          if (section === 'header')
            await expect
              .poll(() =>
                page.getByText('Ship the new export flow by Friday').count(),
              )
              .toBe(1);
          if (section === 'brief')
            expect(
              await page
                .getByRole('textbox', { name: 'Goal', exact: true })
                .inputValue(),
            ).toBe('Ship the new export flow by Friday');
          if (section === 'memory')
            await page
              .getByText('Check with Dana before touching billing', {
                exact: true,
              })
              .waitFor();
          if (section === 'models')
            expect(
              await page
                .getByRole('combobox', {
                  name: 'Project chat effort',
                  exact: true,
                })
                .inputValue(),
            ).toBe('medium');
          if (section === 'usage') {
            await page.getByRole('table', { name: 'By model' }).waitFor();
            // The Project total is the sum of every Task row and the
            // Project chats' row; the Project chats' share is its own line.
            expect(
              await page
                .locator('.project-settings__usage-totals dd')
                .allTextContents(),
            ).toEqual([(739_200).toLocaleString(), (191_400).toLocaleString()]);
            expect(
              await page
                .getByRole('table', { name: 'By Task' })
                .locator('tbody th')
                .first()
                .textContent(),
            ).toBe('Project chats');
          }
          // Nothing spills sideways, and every control is reachable.
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          if (width === 390) {
            for (const control of await page
              .locator('.project-settings__body button')
              .all()) {
              const box = await control.boundingBox();
              if (box) expect(box.height).toBeGreaterThanOrEqual(44);
            }
          }
          await page.screenshot({
            path: `${out}/${section}-${theme}-${width}.png`,
            fullPage: true,
          });
        }
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 240_000);
