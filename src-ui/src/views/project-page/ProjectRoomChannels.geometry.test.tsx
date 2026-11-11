/**
 * @vitest-environment jsdom
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectRoomChannel } from '@kontourai/station-contracts/project-room';
import { chromium } from '@playwright/test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../../tests/helpers/css-cascade-fixture';
import {
  ProjectRoomChannelHeader,
  type ProjectRoomChannels,
} from './ProjectRoomChannels';

/**
 * Valid long names that share a prefix must stay distinguishable on a phone.
 * Clipping is a layout outcome of the real cascade, so it is measured in
 * Chromium against index.css plus the Room and channel stylesheets.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../');
const VIEWPORT = { width: 390, height: 844 };
const q3 = 'launch-review-for-the-mobile-checkout-flow-q3';
const q4 = 'launch-review-for-the-mobile-checkout-flow-q4';
const longest =
  'quarterly-planning-review-for-the-mobile-web-checkout-and-payments-flow-q4-2026';
const channels: ProjectRoomChannel[] = [
  {
    channelId: '11111111-1111-4111-8111-111111111111',
    name: 'general',
    isDefault: true,
  },
  {
    channelId: '22222222-2222-4222-8222-222222222222',
    name: q3,
    isDefault: false,
  },
  {
    channelId: '33333333-3333-4333-8333-333333333333',
    name: q4,
    isDefault: false,
  },
  {
    channelId: '44444444-4444-4444-8444-444444444444',
    name: longest,
    isDefault: false,
  },
];
const hook = {
  list: { data: channels, isError: false, refetch: async () => undefined },
  unsupported: false,
  create: { isPending: false },
  update: { isPending: false, isError: false },
} as unknown as ProjectRoomChannels;

function markup(current: ProjectRoomChannel, openSwitcher: boolean) {
  render(
    <section className="project-room project-room--full">
      <header className="project-room__header">
        <div className="project-room__title">
          <ProjectRoomChannelHeader
            channels={hook}
            current={current}
            canEdit={false}
            guards={undefined}
            onSelect={() => {}}
          />
        </div>
      </header>
    </section>,
  );
  if (openSwitcher)
    fireEvent.click(screen.getByRole('button', { name: /switch channel/ }));
  // The switcher portals to `document.body`.
  return document.body.innerHTML;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);
afterEach(cleanup);

describe.skipIf(!chromiumAvailable)(
  'channel names stay distinguishable at phone width (real cascade)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });
    const css = () => {
      const composed = [
        resolveCssImports(resolve(HERE, '../../index.css')),
        resolveCssImports(resolve(HERE, './ProjectRoom.css')),
        resolveCssImports(resolve(HERE, './ProjectRoomChannels.css')),
      ].join('\n');
      assertNoImportsSurvive(composed);
      return composed;
    };
    async function measure(body: string, selector: string) {
      const page = await browser.newPage({ viewport: VIEWPORT });
      try {
        await page.setContent(`<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>${css()}</style></head>
<body style="margin:0;padding:0 16px">${body}</body></html>`);
        return await page.$$eval(
          selector,
          (elements, matched) =>
            elements.map((element) => {
              const el = element as HTMLElement;
              return {
                // The decorative # is aria-hidden; compare the name itself.
                text: el.textContent?.replace(/^#/, ''),
                clipped:
                  el.scrollWidth > el.clientWidth + 1 ||
                  el.scrollHeight > el.clientHeight + 1,
                selector: matched,
              };
            }),
          selector,
        );
      } finally {
        await page.close();
      }
    }

    test('the header shows the whole of a long name that shares a prefix', async () => {
      const names = await measure(
        markup(channels[2], false),
        '.room-channel__label',
      );
      expect(names).toEqual([
        { text: q4, clipped: false, selector: '.room-channel__label' },
      ]);
    });

    test('the switcher shows every name in full, the longest valid one included', async () => {
      const names = await measure(
        markup(channels[1], true),
        '.room-channel-list__name',
      );
      expect(names.map((name) => name.text)).toEqual(
        channels.map((channel) => channel.name),
      );
      expect(names.filter((name) => name.clipped)).toEqual([]);
    });
  },
);

test.skipIf(chromiumAvailable)(
  'channel name geometry: Chromium not installed, cannot verify',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so channel ' +
        'name clipping could not be measured. This is a missing precondition, ' +
        'not a passing check. Install it with `npm run install:playwright`.',
    );
  },
);
