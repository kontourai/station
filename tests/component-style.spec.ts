import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { build } from 'esbuild';
import { contrastRatio } from './helpers/color-contrast';
import { test } from './helpers/fixture-audit';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = `
import './src-ui/src/index.css';
import './src-ui/src/components/chat/chat.css';
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
    <div className="chat-dock__header" aria-label="Collapsed dock geometry"><button className="chat-dock__maximize-btn">Open dock</button></div>
    <div className="session-history-error"><button className="button button--secondary session-history-error__retry">Retry history</button></div>
    <ActionRow overflowLabel="More actions" primary={<Button pending={pending} pendingLabel="Saving" onClick={() => {setCount(count+1);setPending(true);}}>Save</Button>} secondary={<Button onClick={() => setConfirming(true)}>Remove server</Button>} />
    <SdkButton loading={pending} onClick={() => setCount(count+1)}>SDK save</SdkButton>
    {['primary', 'secondary', 'danger', 'danger-outline', 'success', 'link', 'ghost'].map(variant => <Button key={variant} variant={variant} aria-label={'Shared '+variant}>{variant}</Button>)}
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

test('shared primary actions keep instant press and faster release motion', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setContent('<html data-theme="dark"><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: js });
  const action = page.getByRole('button', { name: 'Shared primary', exact: true });
  await action.hover();
  await action.evaluate(async (node) => {
    getComputedStyle(node).transform;
    await Promise.all(node.getAnimations().map((animation) => animation.finished));
  });
  await page.mouse.down();
  const pressed = await action.evaluate((node) => {
    const style = getComputedStyle(node);
    const matrix = new DOMMatrixReadOnly(style.transform);
    return { x: matrix.a, y: matrix.d, duration: style.transitionDuration };
  });
  expect(pressed).toEqual({ x: 0.97, y: 0.97, duration: '0s' });
  await page.mouse.up();
  const released = await action.evaluate((node) => {
    const style = getComputedStyle(node);
    const properties = style.transitionProperty.split(',').map((value) => value.trim());
    const durations = style.transitionDuration.split(',').map(Number.parseFloat);
    return { transform: durations[properties.indexOf('transform')], background: durations[properties.indexOf('background-color')] };
  });
  expect(released.transform).toBe(0.15);
  expect(released.transform).toBeLessThan(released.background);
});

for (const theme of ['light', 'dark']) {
  for (const width of [390, 1280]) {
    test(`shared actions and confirmation remain usable in ${theme} at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 820 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
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
      for (const variant of [
        'primary',
        'secondary',
        'danger',
        'danger-outline',
        'success',
        'link',
        'ghost',
      ]) {
        const action = page.getByRole('button', {
          name: 'Shared ' + variant,
          exact: true,
        });
        await page.mouse.move(0, 0);
        expect(
          await contrastRatio(action),
          variant + ' contrast',
        ).toBeGreaterThanOrEqual(4.5);
        await action.hover();
        await action.evaluate(async (node) => {
          getComputedStyle(node).backgroundColor;
          await Promise.all(
            node.getAnimations().map((animation) => animation.finished),
          );
        });
        expect(
          await contrastRatio(action),
          variant + ' hover contrast',
        ).toBeGreaterThanOrEqual(4.5);
      }
      const retryStyle = await page
        .getByRole('button', { name: 'Retry history' })
        .evaluate((node) => {
          const style = getComputedStyle(node);
          return {
            top: style.paddingTop,
            right: style.paddingRight,
            fontSize: style.fontSize,
          };
        });
      expect(retryStyle.top).toBe('6px');
      expect(retryStyle.right).toBe('12px');
      if (width === 1280) expect(retryStyle.fontSize).toBe('11px');
      if (width === 390) {
        const header = page.getByLabel('Collapsed dock geometry');
        const control = page.getByRole('button', { name: 'Open dock' });
        expect((await control.boundingBox())?.height).toBe(44);
        const recordedHeight = await header.evaluate((node) =>
          Number.parseFloat(
            getComputedStyle(node).getPropertyValue(
              '--chat-dock-header-height',
            ),
          ),
        );
        expect(recordedHeight).toBe(53);
        expect((await header.boundingBox())?.height).toBe(recordedHeight);
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
