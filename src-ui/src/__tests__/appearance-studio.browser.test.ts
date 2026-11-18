import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type { Page } from '@playwright/test';
import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../src-server/__test-utils__/temp-dirs.js';
import { createCustomAppearanceRoutes } from '../../../src-server/routes/me/custom-appearance.js';
import { CustomAppearanceStore } from '../../../src-server/services/identity/custom-appearance.js';
import { scrollBrowserFixture } from './scroll-browser-fixture';

const makeTempDir = trackTempDirs();
const screenshotDir = resolve('.kontourai/appearance-studio/screenshots');

const fixtureSource = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setClientCredentialResolver } from '@kontourai/station-sdk';
import { CustomAppearanceSection } from '@/pages/CustomAppearanceSection';
import { AppearanceProposalCard } from '@/components/chat/AppearanceProposalCard';
import { ConversationConnectionProvider } from '@/components/conversation/ConversationConnectionContext';
import { customAppearancePreviewBar } from '@/lib/custom-appearance/preview';
import { getCustomAppearanceSnapshot, subscribeCustomAppearance, setActiveCustomAppearance } from '@/lib/custom-appearance/controller';
import { useCustomAppearanceQuery } from '@kontourai/station-sdk';
import '@/index.css';
import '@/pages/AppearancePage.css';
const scope = {apiBase:'http://station.test',authorityKey:'appearance-fixture',isCurrent:()=>true};
setClientCredentialResolver(()=>({origin:scope.apiBase,credential:'fixture',requestAuthority:scope}));
const client = new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0,staleTime:0}}});
function Bridge(){const query=useCustomAppearanceQuery(scope);React.useEffect(()=>{if(query.data)setActiveCustomAppearance(query.data.active);},[query.data]);return null;}
let chooseStudio;
function App(){const [studio,setStudio]=React.useState(false);chooseStudio=setStudio;const [proposal,setProposal]=React.useState(null);React.useEffect(()=>{fetch('/fixture-proposal').then(r=>r.json()).then(setProposal)},[]);return <QueryClientProvider client={client}><Bridge/><main className="main-content fixture-main"><h1>Appearance</h1><p>Make this Station feel like yours.</p><div className="fixture-layout"><div aria-label="Appearance settings"><CustomAppearanceSection key={studio ? "studio" : "legacy"} studioEnabled={studio}/></div><section aria-label="Conversation" className="fixture-chat"><h2>Design conversation</h2><p data-surface="message" data-message-role="user">A warm paper workspace with an illustrated background.</p>{studio && proposal && <ConversationConnectionProvider value={{apiBase:scope.apiBase,requestScope:scope}}><AppearanceProposalCard proposal={proposal} sessionId="appearance-session"/></ConversationConnectionProvider>}<div data-surface="composer">Message your agent…</div></section></div></main></QueryClientProvider>}
createRoot(document.getElementById('root')).render(<App/>);
window.appearanceFixture={studio:(value)=>chooseStudio(value),snapshot:getCustomAppearanceSnapshot,bar:()=>{const bar=customAppearancePreviewBar();if(!bar)return null;const r=bar.keepRect();return {blocked:bar.keepBlockedReason(),x:r.x+r.width/2,y:r.y+r.height/2};}};
`;

async function clickKeep(page: Page) {
  await page.waitForFunction(
    () =>
      !!(
        window as unknown as { appearanceFixture: { bar(): unknown } }
      ).appearanceFixture.bar(),
  );
  const point = await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        appearanceFixture: {
          bar(): { blocked: string | null; x: number; y: number } | null;
        };
      }
    ).appearanceFixture;
    return fixture.bar();
  });
  expect(point).not.toBeNull();
  expect(point!.blocked).toBeNull();
  await page.mouse.click(point!.x, point!.y);
}

test('real editor upload, portable file roundtrip, scoped library and inline trusted Keep render at both widths and themes', async () => {
  mkdirSync(screenshotDir, { recursive: true });
  const store = new CustomAppearanceStore(
    makeTempDir('appearance-studio-browser-'),
  );
  const api = new Hono().route(
    '/api/me',
    createCustomAppearanceRoutes({
      store,
      resolvePrincipal: () => humanPrincipal('fixture', 'alice', 'Alice'),
      tenantId: () => undefined,
      studioEnabled: () => true,
      resolveProposalSourceSessionId: () => 'appearance-session',
    }),
  );
  const initial = await (await api.request('/api/me/appearance')).json();
  const seeded = await (
    await api.request('/api/me/appearance/proposal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        revision: initial.data.revision,
        appearance: {
          version: 1,
          name: 'Warm paper',
          palette: {
            dark: {
              roles: {
                '--k-bg': '#101820',
                '--k-panel': '#16212c',
                '--k-panel-raised': '#1b2938',
                '--k-text': '#f2f4f7',
                '--k-text-muted': '#c6d0da',
                '--k-text-faint': '#9eaebf',
                '--k-positive': '#99ffcc',
                '--k-caution': '#ffe7a0',
                '--k-negative': '#ff99aa',
                '--k-active': '#99ddff',
                '--k-status-contrast': '#101820',
              },
              accent: '#99ddff',
            },
            light: {
              roles: {
                '--k-bg': '#f8f2e7',
                '--k-panel': '#fffdf8',
                '--k-panel-raised': '#ffffff',
                '--k-text': '#253547',
                '--k-text-muted': '#3c5065',
                '--k-text-faint': '#4a5a6a',
                '--k-positive': '#006622',
                '--k-caution': '#665500',
                '--k-negative': '#990022',
                '--k-active': '#005577',
                '--k-status-contrast': '#fffdf8',
              },
              accent: '#005577',
            },
          },
          css: '',
          visual: { radius: 16, fontSize: 15 },
        },
      }),
    })
  ).json();
  expect(seeded.success).toBe(true);
  const configure = async (page: Page) => {
    await page.route('http://station.test/api/**', async (route) => {
      if (route.request().url().endsWith('/api/feature-previews'))
        return route.fulfill({
          json: {
            success: true,
            data: [{ id: 'appearance-studio', enabled: true }],
          },
        });
      const response = await api.request(route.request().url(), {
        method: route.request().method(),
        headers: route.request().headers(),
        body: route.request().postData() ?? undefined,
      });
      return route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      });
    });
    await page.route('http://station.test/fixture-proposal', (route) =>
      route.fulfill({
        json: {
          id: seeded.data.proposal.id,
          name: 'Warm paper',
          sourceSessionId: 'appearance-session',
        },
      }),
    );
  };
  const { browser, page, errors } = await scrollBrowserFixture(
    fixtureSource,
    [
      {
        name: 'appearance-owner',
        setup(builder) {
          builder.onResolve({ filter: /^\/(fonts\/|favicon)/ }, (args) => ({
            path: resolve('src-ui/public', args.path.slice(1)),
          }));
          builder.initialOptions.loader = {
            ...builder.initialOptions.loader,
            '.woff2': 'dataurl',
            '.woff': 'dataurl',
            '.png': 'dataurl',
            '.svg': 'dataurl',
          };
          builder.onResolve({ filter: /contexts\/ApiBaseContext$/ }, () => ({
            path: 'appearance-owner',
            namespace: 'appearance-owner',
          }));
          builder.onLoad(
            { filter: /.*/, namespace: 'appearance-owner' },
            () => ({
              contents: `export const useHostRequestAuthorityScope=()=>({apiBase:'http://station.test',authorityKey:'appearance-fixture',isCurrent:()=>true});`,
              loader: 'js',
            }),
          );
        },
      },
    ],
    { viewport: { width: 1440, height: 1000 }, acceptDownloads: true },
    configure,
  );
  try {
    await page.addStyleTag({
      content: `.fixture-main{padding:24px;overflow:auto;display:block}.fixture-layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:24px;align-items:start}.fixture-chat{position:sticky;top:0;padding:16px;border:1px solid var(--k-line);border-radius:var(--k-radius-panel);background:var(--k-panel)}@media(max-width:700px){.fixture-main{padding:12px}.fixture-layout{grid-template-columns:minmax(0,1fr)}.fixture-chat{position:static}}`,
    });
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    for (const width of [390, 1440])
      for (const mode of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(
          (theme) => (document.documentElement.dataset.theme = theme),
          mode,
        );
        await page.locator('.fixture-main').evaluate((element) => {
          element.scrollTop = 0;
        });
        await page.screenshot({
          path: join(screenshotDir, `before-${mode}-${width}.png`),
        });
      }
    await page.evaluate(() =>
      (
        window as unknown as {
          appearanceFixture: { studio(value: boolean): void };
        }
      ).appearanceFixture.studio(true),
    );
    const conversation = page.getByRole('region', { name: 'Conversation' });
    await conversation
      .getByRole('button', { name: 'Preview', exact: true })
      .waitFor();
    for (const width of [390, 1440])
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(
          (mode) => (document.documentElement.dataset.theme = mode),
          theme,
        );
        await conversation.screenshot({
          path: join(screenshotDir, `inline-proposed-${theme}-${width}.png`),
        });
      }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await conversation
      .getByRole('button', { name: 'Preview', exact: true })
      .click();
    await clickKeep(page);
    await conversation.getByText('Kept', { exact: true }).waitFor();
    const kept = await (await api.request('/api/me/appearance')).json();
    expect(kept.data.active.name).toBe('Warm paper');
    await page
      .getByRole('button', { name: 'More theme library actions' })
      .click();
    await page.getByRole('menuitem', { name: 'Edit current theme' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Illustrated paper');
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d')!;
      const gradient = ctx.createLinearGradient(0, 0, 640, 360);
      gradient.addColorStop(0, '#e1b782');
      gradient.addColorStop(1, '#30495a');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#223e45';
      ctx.beginPath();
      ctx.moveTo(0, 360);
      ctx.lineTo(220, 110);
      ctx.lineTo(400, 300);
      ctx.lineTo(540, 150);
      ctx.lineTo(640, 360);
      ctx.fill();
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.getByLabel('Background image file').setInputFiles({
      name: 'landscape.png',
      mimeType: 'image/png',
      buffer: Buffer.from(png, 'base64'),
    });
    await page
      .getByRole('img', { name: 'Your background', exact: true })
      .waitFor();
    const upload = await page
      .getByRole('img', { name: 'Your background', exact: true })
      .getAttribute('src');
    expect(upload).toMatch(/^data:image\/(webp|png);base64,/);
    await page
      .getByRole('button', { name: 'Save to library', exact: true })
      .click();

    await page
      .getByRole('status')
      .filter({ hasText: 'Saved to your theme library.' })
      .waitFor();
    for (const name of ['Illustrated paper second', 'Illustrated paper']) {
      await page.getByLabel('Name', { exact: true }).fill(name);
      await page
        .getByRole('button', { name: 'Save to library', exact: true })
        .click();
      await page
        .getByRole('status')
        .filter({ hasText: 'Saved to your theme library.' })
        .waitFor();
    }
    const library = await (
      await api.request('/api/me/appearance/library')
    ).json();
    expect(library.data.themes).toHaveLength(1);
    expect(library.data.themes[0].appearance.visual.background.dataUrl).toBe(
      upload,
    );
    for (const width of [390, 1440])
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(
          (mode) => (document.documentElement.dataset.theme = mode),
          theme,
        );
        await page.locator('.fixture-main').evaluate((element) => {
          element.scrollTop = 0;
        });
        await page.screenshot({
          path: join(screenshotDir, `editor-${theme}-${width}.png`),
        });
        await conversation.screenshot({
          path: join(screenshotDir, `inline-${theme}-${width}.png`),
        });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }
    await page.getByRole('button', { name: 'More appearance actions' }).click();
    await page.getByRole('menuitem', { name: 'Cancel editing' }).click();
    for (const width of [390, 1440])
      for (const mode of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(
          (theme) => (document.documentElement.dataset.theme = theme),
          mode,
        );
        await page.getByRole('region', { name: 'Theme library' }).screenshot({
          path: join(screenshotDir, `library-${mode}-${width}.png`),
        });
      }

    const libraryCard = page.locator('.appearance-studio__card').filter({
      has: page.getByRole('heading', {
        name: 'Illustrated paper',
        exact: true,
      }),
    });
    await libraryCard
      .getByRole('button', { name: 'More actions for Illustrated paper' })
      .click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Export theme pack' }).click();
    const downloaded = await downloadPromise;
    const file = join(screenshotDir, 'portable.station-theme.json');
    await downloaded.saveAs(file);
    await page.getByLabel('Theme pack file').setInputFiles(file);
    await page
      .getByText('Imported theme draft. Preview it before applying.', {
        exact: true,
      })
      .waitFor();
    expect(
      (await (await api.request('/api/me/appearance')).json()).data.active.name,
    ).toBe('Warm paper');
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 120_000);
