import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import type { Plugin } from 'esbuild';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import type { RestartFixtureControl } from './local-restart-notice.browser.fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// Exclusive browser fixture: production restart caller, modal, toast provider,
// store and renderer; only unrelated bootstrap reads and native delivery vary.
const bootstrap: Plugin = {
  name: 'local-restart-bootstrap',
  setup(builder) {
    const modules: Record<string, string> = {
      '/hooks/useSystemStatus':
        'export const useSystemStatus=()=>({refetch:async()=>{}});',
      '/hooks/useRecoveryConfig':
        'export const useRecoveryConfig=()=>({data:{firstRun:{status:"completed"}}});',
      '/hooks/usePairingDeepLink': 'export const usePairingDeepLink=()=>{};',
      '/platform/PlatformProfileContext': `export {PlatformBootstrap,usePlatformProfile,useNativeProfileSelection,useNativeProfileStoreEpoch,nativeProfileBootstrapRecoveryError} from ${JSON.stringify(resolve('src-ui/src/__tests__/local-restart-notice.browser.fixture.tsx'))}; const profiles=[]; export const nativeProfileRepository=()=>({pendingLocalSelfProvisionProfileName:()=>undefined,getRelayRouteProfiles:()=>profiles,subscribeRelayRouteProfiles:()=>()=>{}});`,
      '/components/UsageTelemetryDisclosure':
        'export const UsageTelemetryDisclosure=()=>null;',
      '/registry/StationExtensionsAccess':
        'export const StationExtensionsAccess=()=>null;',
    };
    builder.onResolve({ filter: /.*/ }, (args) => {
      const importer = args.importer.replaceAll('\\', '/');
      const path = (
        args.path.startsWith('.')
          ? resolve(dirname(args.importer), args.path)
          : args.path
      ).replaceAll('\\', '/');
      const key = Object.keys(modules).find((suffix) => path.endsWith(suffix));
      if (key) return { path: key, namespace: 'restart-bootstrap' };
      if (
        args.path === './native' &&
        importer.endsWith('/platform/useBundledServerStatus.ts')
      ) {
        return { path: 'native-delivery', namespace: 'restart-bootstrap' };
      }
      return undefined;
    });
    builder.onLoad(
      { filter: /.*/, namespace: 'restart-bootstrap' },
      (args) => ({
        contents:
          args.path === 'native-delivery'
            ? `import {adapter} from ${JSON.stringify(resolve('src-ui/src/__tests__/local-restart-notice.browser.fixture.tsx'))}; export const nativePlatformPromise=Promise.resolve().then(()=>adapter);`
            : modules[args.path],
        resolveDir: process.cwd(),
        loader: 'tsx',
      }),
    );
  },
};

test('local restart recovery keeps the current notice and keyboard retry across response ordering', async () => {
  const output = resolve('.surface', `ux14-restart-076fbf75-${randomUUID()}`);
  mkdirSync(output, { recursive: true });
  let sequence = 0;
  let currentStage = 'bootstrap';
  let firstFailure: unknown;
  let failed = false;
  const journal = (event: string, data: unknown = null) => {
    appendFileSync(
      resolve(output, 'stages.jsonl'),
      `${JSON.stringify({ sequence: ++sequence, stage: currentStage, event, data })}\n`,
      { encoding: 'utf8', flush: true },
    );
  };
  const secondaryErrors: string[] = [];
  const secondaryJournal = (event: string, data: unknown = null) => {
    try {
      journal(event, data);
    } catch (error) {
      if (!failed) {
        failed = true;
        firstFailure = error;
      }
      const diagnostic =
        `Journal I/O failed during ${event}: ${String(error)}`.slice(0, 2000);
      secondaryErrors.push(diagnostic);
      try {
        console.error(diagnostic);
      } catch (consoleError) {
        secondaryErrors.push(
          `Console fallback failed: ${String(consoleError)}`.slice(0, 2000),
        );
      }
    }
  };
  journal('binding', {
    head: '076fbf75be660953b159b48cd166df415e5f6341',
    manifest:
      'a3a16c01291eed4fec4eb3e4232d5079bb250c25e4788ade981158e02395d06f',
    fixture: 'fa920b36c99c8853a0728a89e24ffa88165ae6079f94e1af64c1f81744c4d88f',
    browserEnvironment: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null,
    command:
      'npm run test:focused -- src-ui/src/__tests__/local-restart-notice.browser.test.tsx',
    output,
  });
  // A final before-stage is an observation, not a diagnosis of a global timeout.
  journal('before');
  const { browser, page, errors } = await scrollBrowserFixture(
    `import {mountRestartFixture} from './src-ui/src/__tests__/local-restart-notice.browser.fixture'; mountRestartFixture();`,
    [bootstrap],
  );
  const observedPageErrors: string[] = [];
  const recordPageError = (error: Error) => {
    observedPageErrors.push(error.message);
    secondaryJournal('pageerror', error.message);
  };
  page.on('pageerror', recordPageError);
  page.setDefaultTimeout(1500);
  page.setDefaultNavigationTimeout(1500);
  const snapshot = async (target: Page) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        target.evaluate(() => ({
          url: location.href,
          body: document.body?.innerText.slice(0, 20_000) ?? '',
          activeElement: document.activeElement?.outerHTML.slice(0, 2000) ?? '',
        })),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Diagnostic snapshot exceeded 750ms')),
            750,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const stage = async <T,>(
    label: string,
    action: () => Promise<T>,
  ): Promise<T> => {
    currentStage = label;
    journal('before');
    try {
      journal('snapshot', await snapshot(page));
    } catch (error) {
      journal('snapshot-secondary-error', String(error));
    }
    expect(errors).toEqual([]);
    expect(observedPageErrors).toEqual([]);
    if (failed) throw firstFailure;
    const result = await action();
    journal('after');
    return result;
  };
  try {
    journal('after', { errors });
    expect(errors).toEqual([]);
    await stage('css', () =>
      page.addStyleTag({
        content: resolveCssImports(resolve('src-ui/src/index.css')),
      }),
    );
    const control = () =>
      stage('native-request-count', () =>
        page.evaluate(
          (): RestartFixtureControl['requests'] =>
            window.restartFixture.requests,
        ),
      );
    const settle = (index: number, delivered: boolean) =>
      stage(`native-settle-${index}-${delivered}`, () =>
        page.evaluate(
          ([request, accepted]) =>
            window.restartFixture.settle(request, accepted),
          [index, delivered] as const,
        ),
      );
    const originalRestart = async () => {
      const manageStations = page.getByRole('button', {
        name: 'Manage Stations',
        exact: true,
      });
      for (let step = 0; step < 20; step += 1) {
        if (
          await stage(`ManageStations-focus-${step}`, () =>
            manageStations.evaluate((node) => node === document.activeElement),
          )
        )
          break;
        await stage(`ManageStations-Tab-${step}`, () =>
          page.keyboard.press('Tab'),
        );
      }
      await stage('ManageStations-focused', () =>
        expect
          .poll(
            () =>
              manageStations.evaluate(
                (node) => node === document.activeElement,
              ),
            { timeout: 500 },
          )
          .toBe(true),
      );
      await stage('ManageStations-Enter', () => page.keyboard.press('Enter'));
      await stage('modal-Restart', () =>
        page
          .getByRole('dialog')
          .getByRole('button', { name: 'Restart', exact: true })
          .click(),
      );
      await stage('modal-close', () =>
        page.getByRole('button', { name: 'Close Station manager' }).click(),
      );
    };
    await stage('first-rendered-control', () =>
      page
        .getByRole('button', { name: 'Manage Stations', exact: true })
        .waitFor({ timeout: 1500 }),
    );
    for (const theme of ['light', 'dark']) {
      for (const width of [390, 1440]) {
        await stage(`matrix-${width}-${theme}-viewport`, () =>
          page.setViewportSize({ width, height: 900 }),
        );
        await stage(`matrix-${width}-${theme}-theme`, () =>
          page.evaluate(
            (value) =>
              document.documentElement.setAttribute('data-theme', value),
            theme,
          ),
        );
        const start = await control();
        await originalRestart();
        await stage('native-first-request', () =>
          expect.poll(control, { timeout: 500 }).toBe(start + 1),
        );
        await settle(start, false);
        const card = page
          .getByTestId('toast-card')
          .filter({ hasText: "Couldn't restart the local Station" });
        const retry = card.getByRole('button', {
          name: 'Retry',
          exact: true,
        });
        await stage('retry-visible', () => retry.waitFor({ timeout: 1500 }));
        // Traverse ordinary focus order; never force focus through a modal.
        for (let step = 0; step < 20; step += 1) {
          if (
            await stage(`retry-keyboard-focus-${step}`, () =>
              retry.evaluate((node) => node === document.activeElement),
            )
          )
            break;
          await stage(`retry-keyboard-Tab-${step}`, () =>
            page.keyboard.press('Tab'),
          );
        }
        await stage('retry-focus', () =>
          expect
            .poll(
              () => retry.evaluate((node) => node === document.activeElement),
              { timeout: 500 },
            )
            .toBe(true),
        );
        await stage('retry-keyboard-Enter', () => page.keyboard.press('Enter'));
        const working = card.getByRole('button', { name: 'Working…' });
        await stage('retry-pending-disabled', () =>
          expect.poll(() => working.isDisabled(), { timeout: 500 }).toBe(true),
        );
        await originalRestart();
        await stage('native-overlapping-requests', () =>
          expect.poll(control, { timeout: 500 }).toBe(start + 3),
        );
        await settle(start + 2, false);
        await settle(start + 1, true);
        await stage('retry-survives-older-success', () =>
          retry.waitFor({ timeout: 1500 }),
        );
        expect(await stage('current-card-count', () => card.count())).toBe(1);
        const geometry = await stage(`matrix-${width}-${theme}-geometry`, () =>
          retry.evaluate((node) => {
            const box = node.getBoundingClientRect();
            return {
              width: box.width,
              height: box.height,
              right: box.right,
              left: box.left,
            };
          }),
        );
        expect(geometry.width).toBeGreaterThanOrEqual(44);
        expect(geometry.height).toBeGreaterThanOrEqual(44);
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(width);
        await stage(`matrix-${width}-${theme}-screenshot`, () =>
          page.screenshot({
            path: resolve(output, `${width}-${theme}.png`),
            timeout: 1500,
          }),
        );
        // A failed real action must retain a usable recovery control.
        await stage('retry-click', () => retry.click());
        await stage('native-retry-request', () =>
          expect.poll(control, { timeout: 500 }).toBe(start + 4),
        );
        await settle(start + 3, false);
        await stage('retry-survives-current-failure', () =>
          retry.waitFor({ timeout: 1500 }),
        );
        await stage('retry-enabled', () =>
          expect.poll(() => retry.isEnabled(), { timeout: 500 }).toBe(true),
        );
        await originalRestart();
        await originalRestart();
        await settle(start + 5, true);
        await settle(start + 4, false);
        await stage('latest-success-remains-clear', () =>
          expect.poll(() => card.count(), { timeout: 500 }).toBe(0),
        );
        expect(
          await stage('retained-note', () =>
            page.getByRole('textbox', { name: 'Unsent note' }).inputValue(),
          ),
        ).toBe('Keep my investigation notes');
        expect(
          await stage('no-health-claim', () =>
            page.getByText(/Station is running|Restart succeeded/).count(),
          ),
        ).toBe(0);
      }
    }
    expect(errors).toEqual([]);
  } catch (error) {
    if (!failed) {
      failed = true;
      firstFailure = error;
    }
    secondaryJournal('first-failure', {
      error: String(error),
      url: page.url(),
      errors,
      observedPageErrors,
    });
    try {
      secondaryJournal('failure-snapshot', await snapshot(page));
    } catch (captureError) {
      secondaryJournal(
        'failure-snapshot-secondary-error',
        String(captureError),
      );
    }
    try {
      await page.screenshot({
        path: resolve(output, 'failure.png'),
        timeout: 750,
      });
      secondaryJournal('failure-png', resolve(output, 'failure.png'));
    } catch (captureError) {
      secondaryJournal('failure-png-secondary-error', String(captureError));
    }
  } finally {
    secondaryJournal('cleanup-before');
    try {
      await browser.close();
      secondaryJournal('cleanup-after');
    } catch (cleanupError) {
      if (!failed) {
        failed = true;
        firstFailure = cleanupError;
      }
      secondaryErrors.push(String(cleanupError).slice(0, 2000));
      secondaryJournal('cleanup-secondary-error', String(cleanupError));
    }
  }
  if (failed) throw firstFailure;
});
