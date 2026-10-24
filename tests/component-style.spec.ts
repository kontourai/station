import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { build } from 'esbuild';
import { contrastRatio } from './helpers/color-contrast';
import { test } from './helpers/fixture-audit';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = `
import './src-ui/src/index.css';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { Button } from './src-ui/src/components/Button';
import { Button as SdkButton } from './packages/sdk/src/components/Button';
import { NoticeAction } from './src-ui/src/components/notifications/NoticeAction';
import { DeleteIntegrationModal } from './src-ui/src/views/integrations/DeleteIntegrationModal';
import { ActionRow } from './src-ui/src/components/ActionRow';
function Controls() {
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [count, setCount] = useState(0);
  return <main style={{padding:'24px',background:'var(--k-panel)',color:'var(--k-text)'}}>
    <p role="status">Invocations: {count}</p>
    <ActionRow overflowLabel="More actions" primary={<Button pending={pending} pendingLabel="Saving" onClick={() => {setCount(count+1);setPending(true);}}>Save</Button>} secondary={<Button onClick={() => setConfirming(true)}>Remove server</Button>} />
    <SdkButton loading={pending} onClick={() => setCount(count+1)}>SDK save</SdkButton>
    <NoticeAction className="notice-action--primary" onClick={() => setCount(count+1)}>Allow</NoticeAction>
    <NoticeAction className="notice-action--danger" onClick={() => setCount(count+1)}>Deny</NoticeAction>
    <a className="button notice-action notice-action--secondary" href="#details">Open session</a>
    {confirming && <DeleteIntegrationModal integrationName="Fixture server" onCancel={() => setConfirming(false)} onConfirm={() => {setCount(count+1);setConfirming(false);}} />}
  </main>;
}
createRoot(document.getElementById('root')).render(<Controls />);
`;
let js = '';
let css = '';
test.beforeAll(async () => {
  const bundle = await build({
    stdin: { contents: source, resolveDir: root, loader: 'tsx' },
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' },
    external: ['/fonts/*', '/favicon-*'],
    loader: { '.woff2': 'empty', '.woff': 'empty' },
    write: false,
    outdir: 'component-style-harness',
    logLevel: 'silent',
  });
  for (const output of bundle.outputFiles) {
    if (output.path.endsWith('.js')) js = output.text;
    if (output.path.endsWith('.css')) css = output.text;
  }
  expect(js.length).toBeGreaterThan(0);
  expect(css.length).toBeGreaterThan(0);
});

for (const theme of ['light', 'dark']) {
  for (const width of [390, 1280]) {
    test(`shared actions and confirmation remain usable in ${theme} at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 820 });
      await page.setContent(
        `<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>`,
      );
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: js });
      for (const name of ['Allow', 'Deny']) {
        const action = page.getByRole('button', { name, exact: true });
        await expect(action).toBeVisible();
        expect(await contrastRatio(action)).toBeGreaterThanOrEqual(4.5);
        const bounds = await action.boundingBox();
        expect(bounds?.height).toBeGreaterThanOrEqual(44);
      }
      const session = page.getByRole('link', { name: 'Open session' });
      expect((await session.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await session.click();
      await expect(page).toHaveURL(/#details$/);
      const trigger = page.getByRole('button', { name: 'Remove server' });
      await trigger.click();
      const dialog = page.getByRole('alertdialog', {
        name: 'Delete Tool Server',
      });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole('button', { name: 'Cancel', exact: true }),
      ).toBeFocused();
      const bounds = await dialog.boundingBox();
      expect(bounds?.x).toBeGreaterThanOrEqual(0);
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(
        width,
      );
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Saving', exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole('button', { name: 'SDK save', exact: true }),
      ).toBeDisabled();
      await expect(page.getByRole('status')).toHaveText('Invocations: 1');
    });
  }
}
