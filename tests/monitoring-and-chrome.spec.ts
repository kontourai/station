import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { test } from './helpers/fixture-audit';

// Real components and styles; no server or copied component implementation.
const root = process.cwd();
let script = '';
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: root,
      loader: 'tsx',
      contents: `
      import { createRoot } from 'react-dom/client';
      import { EventEntrySections } from './src-ui/src/components/monitoring/event-entry/EventEntrySections';
      import { DetailHeader } from './src-ui/src/components/DetailHeader';
      import { ProjectSidebarHeader } from './src-ui/src/components/project-sidebar/ProjectSidebarHeader';
      import { ChatDockHeaderMoreMenu } from './src-ui/src/components/chat-dock/ChatDockHeaderMoreMenu';
      window.serializations = 0;
      const rows = Array.from({length: 200}, (_, id) => ({
        timestamp: '2026-09-06T12:00:00Z', 'trace.id': String(id),
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.call.result': { toJSON() { window.serializations++; return { text: 'x'.repeat(4096) }; } },
      }));
      const noop = () => {};
      createRoot(document.getElementById('root')).render(window.scenario === 'monitoring'
        ? <div>{rows.map((event, i) => <EventEntrySections key={i} event={event} onCopyResult={text => window.copied = text} />)}</div>
        : <div>
          <div className="sidebar" style={{width: 260}}><ProjectSidebarHeader appName="Station" homeLabel="Station Nightly" channelBadge="Nightly" collapsed={false} isMobile={false} onGoHome={noop} onCloseMobile={noop} onToggleCollapse={noop} /></div>
          <DetailHeader title="Project settings"><button>Save</button><button>More actions</button></DetailHeader>
          <ChatDockHeaderMoreMenu actions={[{key:'copy',label:'Copy thread ID',onSelect:()=>window.selected=true},{key:'settings',label:'Chat settings',onSelect:noop}]} />
        </div>);
    `,
    },
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'empty' },
    write: false,
  });
  script = result.outputFiles[0].text;
});

async function mount(page: Page, scenario: string) {
  await page.setContent(
    '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>',
  );
  for (const file of [
    'tokens.css',
    'index.css',
    'components/DetailHeader.css',
    'components/project-sidebar/ProjectSidebar.css',
    'components/chat/chat.css',
  ]) {
    await page.addStyleTag({ path: join(root, 'src-ui/src', file) });
  }
  await page.evaluate((value) => {
    (window as any).scenario = value;
  }, scenario);
  await page.addScriptTag({ content: script });
}

test('collapsed monitoring payloads do no serialization or payload DOM work', async ({
  page,
}, info) => {
  await mount(page, 'monitoring');
  await expect(page.locator('summary')).toHaveCount(200);
  const observation = await page.evaluate(() => ({
    serializations: (window as any).serializations,
    payloadNodes: document.querySelectorAll('pre').length,
  }));
  await info.attach('mounted-monitoring-work.json', {
    body: JSON.stringify(observation),
    contentType: 'application/json',
  });
  expect(observation).toEqual({ serializations: 0, payloadNodes: 0 });
  await page.locator('summary').first().click();
  await expect(page.locator('pre')).toHaveCount(1);
  await expect(page.locator('pre')).toContainText('xxxx');
  await page.getByTitle('Copy to clipboard').first().click();
  expect(await page.evaluate(() => (window as any).copied)).toContain('xxxx');
});

for (const touch of [false, true]) {
  test.describe(touch ? 'touch tablet' : 'fine pointer tablet', () => {
    test.use({ viewport: { width: 1000, height: 800 }, hasTouch: touch });
    test('responsive chrome keeps actions reachable and the channel below its name', async ({
      page,
    }) => {
      await mount(page, 'chrome');
      const title = page.getByRole('heading', { name: 'Project settings' });
      const save = page.getByRole('button', { name: 'Save', exact: true });
      await expect(save).toBeVisible();
      const titleBox = (await title.boundingBox())!;
      const saveBox = (await save.boundingBox())!;
      expect(saveBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
      expect(saveBox.height).toBeGreaterThanOrEqual(44);
      const brand = (await page
        .getByText('Station', { exact: true })
        .boundingBox())!;
      const channel = (await page
        .getByText('Nightly', { exact: true })
        .boundingBox())!;
      expect(channel.y).toBeGreaterThanOrEqual(brand.y + brand.height);
      expect(Math.abs(channel.x - brand.x)).toBeLessThan(1);
      await page
        .getByRole('button', { name: 'More dock actions', exact: true })
        .click();
      const copy = page.getByRole('menuitem', { name: 'Copy thread ID' });
      await expect(copy).toBeVisible();
      expect((await copy.boundingBox())!.height).toBeGreaterThanOrEqual(
        touch ? 44 : 32,
      );
      await copy.click();
      expect(await page.evaluate(() => (window as any).selected)).toBe(true);
    });
  });
}
