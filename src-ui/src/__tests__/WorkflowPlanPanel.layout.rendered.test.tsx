/**
 * @vitest-environment jsdom
 *
 * The plan pane's Steps list rendered as a ~15px sliver in the Coding
 * inspector: that host gives the panel no height, and the steps region's
 * zero flex basis then collapsed it to its padding. This lays the real panel
 * out with its real stylesheet in Chromium, in a host that gives it no height
 * and in one that bounds it.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';
import {
  type WorkflowPlanArtifact,
  WorkflowPlanPanel,
} from '../components/flow/WorkflowPlanPanel';

vi.mock('../components/chat/LazyMarkdown', () => ({
  LazyMarkdown: ({ children }: { children?: string }) => <div>{children}</div>,
}));

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);
const PANEL_CSS = resolveCssImports(
  resolve(HERE, '../components/coding-layout/CodingLayout.css'),
);

const ARTIFACT: WorkflowPlanArtifact = {
  title: 'Migrate session storage',
  markdown: '',
  rawText: '',
  steps: Array.from({ length: 6 }, (_, index) => ({
    id: `s${index}`,
    label: `Phase ${index + 1}: a step of the migration`,
    status: 'pending' as const,
  })),
};

afterEach(cleanup);

describe.skipIf(!chromiumAvailable)('plan pane steps layout', () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function layout(hostStyle: string) {
    const { container } = render(<WorkflowPlanPanel artifact={ARTIFACT} />);
    const context = await browser.newContext({
      viewport: { width: 440, height: 900 },
    });
    const tab = await context.newPage();
    await tab.setContent(
      `<!doctype html><html><head><style>${PANEL_CSS}</style></head><body style="margin:0"><div id="host" style="${hostStyle}">${container.innerHTML}</div></body></html>`,
    );
    const measured = await tab.evaluate(() => {
      const body = document.querySelector<HTMLElement>(
        '.workflow-plan-panel__body',
      )!;
      const steps = document.querySelector<HTMLElement>(
        '.workflow-plan-panel__steps',
      )!;
      return {
        body: body.getBoundingClientRect().height,
        steps: steps.getBoundingClientRect().height,
        scrolls: body.scrollHeight > body.clientHeight,
      };
    });
    await context.close();
    return measured;
  }

  test('a host that gives the panel no height shows every step', async () => {
    const { body, steps } = await layout('display:block');
    // Six step cards; each is well over 40px tall.
    expect(steps).toBeGreaterThan(6 * 40);
    expect(body).toBeGreaterThanOrEqual(steps);
  });

  test('a host that bounds the panel keeps its header and scrolls the steps', async () => {
    const { body, scrolls } = await layout(
      'display:flex;flex-direction:column;height:420px',
    );
    expect(body).toBeGreaterThan(40);
    expect(body).toBeLessThan(420);
    expect(scrolls).toBe(true);
  });
});
