/** @vitest-environment jsdom */
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { cleanup, render } from '@testing-library/react';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../../tests/helpers/css-cascade-fixture';
import { WorkspacePaneFailure } from '../WorkspacePaneFailure';

/**
 * The pane-failure card's actions (Try again, Close this chat, Minimize) get
 * their 44px floor from the shared `__actions` rule and the card's own CSS, and
 * jsdom computes no layout, so nothing demonstrated them. This renders the real
 * card, with the production Chat labels, into Chromium with the real
 * stylesheets at phone widths and measures each control: at least 44px tall and
 * wholly inside the screen.
 *
 * No e2e journey reaches this state (it needs a pane renderer to throw), which
 * is why it is measured here rather than in a Playwright spec.
 */
const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const css = ['../../index.css', '../WorkspacePaneFailure.css']
  .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
  .join('\n');
assertNoImportsSurvive(css);

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)('WorkspacePaneFailure geometry', () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });
  afterEach(cleanup);

  test.each([390, 320])(
    'Try again, Close this chat and Minimize are 44px targets inside a %ipx screen',
    async (width) => {
      const { container } = render(
        <WorkspacePaneFailure
          paneName="Chat"
          detail={{ name: 'TypeError', message: 'boom' }}
          context={{
            subject: { label: 'Chat', name: 'Are you running the latest?' },
            back: { label: 'Close this chat', onBack: vi.fn() },
            dismiss: { label: 'Minimize', onDismiss: vi.fn() },
          }}
          onRetry={vi.fn()}
        />,
      );
      const page = await browser.newPage({ viewport: { width, height: 700 } });
      try {
        await page.setContent(
          `<style>${css}</style><div style="height:700px;display:flex;flex-direction:column">${container.innerHTML}</div>`,
        );
        const measured: Record<string, string> = {};
        for (const name of ['Try again', 'Close this chat', 'Minimize']) {
          const box = await page
            .getByRole('button', { name, exact: true })
            .boundingBox();
          const problems: string[] = [];
          if (!box) problems.push('no box');
          else {
            if (box.height < 44) problems.push(`height ${box.height}`);
            if (box.width < 44) problems.push(`width ${box.width}`);
            if (box.x < 0 || box.x + box.width > width)
              problems.push(`x ${box.x}..${box.x + box.width}`);
          }
          measured[name] = problems.join(', ') || 'ok';
        }
        expect(measured).toEqual({
          'Try again': 'ok',
          'Close this chat': 'ok',
          Minimize: 'ok',
        });
      } finally {
        await page.close();
      }
    },
  );
});
