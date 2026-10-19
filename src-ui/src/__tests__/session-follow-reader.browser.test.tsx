import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { Page } from '@playwright/test';
import type { Plugin } from 'esbuild';
import { expect, test } from 'vitest';
import { scrollBrowserFixture } from './scroll-browser-fixture';

const sessionFixture = (sibling: 'above' | 'below' | null = null) =>
  scrollBrowserFixture(`
    import React, {useRef, useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {useSessionTranscriptScroll} from './src-ui/src/components/session-detail/useSessionTranscriptScroll';
    function App(){
      const scrollRef = useRef(null), contentRef = useRef(null);
      const [height, setHeight] = useState(2000);
      const [identity, setIdentity] = useState('session'), [ready, setReady] = useState(true);
      const {atLatest, jumpToLatest} = useSessionTranscriptScroll({identity,scrollRef,contentRef,ready,contentVersion:height});
      return <>{!atLatest && <button onClick={jumpToLatest}>Jump to latest</button>}<button onClick={()=>setHeight(h=>h+100)}>Grow</button><button onClick={()=>{setIdentity('next');setReady(false);setHeight(200)}}>Switch session</button><button onClick={()=>{setReady(true);setHeight(2400)}}>Load</button><div id="scroll" tabIndex={0} ref={scrollRef} style={{height:300,overflow:'auto'}}><div id="above" style={{height:${sibling === 'above' ? 200 : 0}}}/><div id="content" ref={contentRef} style={{height}}>Transcript</div><div id="below" style={{height:${sibling === 'below' ? 200 : 0}}}/></div></>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `);

async function startGrowth(
  page: Page,
  interval: number | 'frame',
  ticks: number,
  selector = '#content',
) {
  await page.evaluate(
    ({ interval, ticks, selector }) => {
      const content = document.querySelector<HTMLElement>(selector)!;
      let height = content.offsetHeight;
      let count = 0;
      document.documentElement.dataset.growing = 'true';
      let timer: number;
      const step = () => {
        height += 20;
        content.style.height = `${height}px`;
        if (++count === ticks) {
          if (interval !== 'frame') clearInterval(timer);
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              document.documentElement.dataset.growing = 'false';
            }),
          );
        } else if (interval === 'frame') {
          requestAnimationFrame(step);
        }
      };
      if (interval === 'frame') requestAnimationFrame(step);
      else timer = window.setInterval(step, interval);
    },
    { interval, ticks, selector },
  );
}

async function finishGrowth(page: Page) {
  await page.waitForFunction(
    () => document.documentElement.dataset.growing === 'false',
  );
}

async function tailGap(page: Page, selector = '#scroll') {
  return page
    .locator(selector)
    .evaluate(
      (element) =>
        element.scrollHeight - element.scrollTop - element.clientHeight,
    );
}

test('a small upward wheel pauses transcript follow until the reader reaches the true bottom', async () => {
  const { browser, page, errors } = await sessionFixture();
  try {
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 1700,
    );
    await page.locator('#scroll').hover();
    await page.mouse.wheel(0, -12);
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 1688,
    );
    expect(
      await page.getByRole('button', { name: 'Jump to latest' }).isVisible(),
    ).toBe(true);
    await page.waitForTimeout(250);
    await page.getByRole('button', { name: 'Grow' }).click();
    expect(
      await page.locator('#scroll').evaluate((element) => element.scrollTop),
    ).toBe(1688);
    await page.locator('#scroll').hover();
    await page.mouse.wheel(0, 1000);
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 1800,
    );
    await page.waitForTimeout(250);
    await page.getByRole('button', { name: 'Grow' }).click();
    expect(
      await page.locator('#scroll').evaluate((element) => element.scrollTop),
    ).toBe(1900);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('transcript follow survives sustained asynchronous growth between pin echoes', async () => {
  const { browser, page, errors } = await sessionFixture();
  try {
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 1700,
    );
    await startGrowth(page, 16, 60);
    await finishGrowth(page);
    expect(await tailGap(page)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test.each(['ArrowUp', 'PageUp', 'Home'])(
  '%s during streaming pauses follow and exposes Jump to latest',
  async (key) => {
    const { browser, page, errors } = await sessionFixture();
    try {
      await page.waitForFunction(
        () => document.querySelector('#scroll')?.scrollTop === 1700,
      );
      await page.locator('#scroll').focus();
      await startGrowth(page, 100, 10);
      for (let count = 0; count < 3; count++) {
        await page.keyboard.press(key);
        await page.waitForTimeout(150);
      }
      await finishGrowth(page);
      expect(
        await page.locator('#scroll').evaluate((element) => element.scrollTop),
      ).toBeLessThanOrEqual(1640);
      expect(
        await page.getByRole('button', { name: 'Jump to latest' }).isVisible(),
      ).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  },
);

for (const interval of [100, 250]) {
  test.each(['wheel', 'click', 'touchstart'])(
    `a %s at the bottom keeps following during ${interval}ms growth`,
    async (input) => {
      const { browser, page, errors } = await sessionFixture();
      try {
        await page.waitForFunction(
          () => document.querySelector('#scroll')?.scrollTop === 1700,
        );
        await startGrowth(page, interval, 1000 / interval);
        await page.waitForTimeout(Math.max(0, interval - 100));
        if (input === 'wheel') {
          await page.locator('#scroll').hover();
          await page.mouse.wheel(0, 12);
        } else if (input === 'click') {
          await page.locator('#scroll').click();
        } else {
          await page.locator('#scroll').dispatchEvent('touchstart');
        }
        await finishGrowth(page);
        expect(await tailGap(page)).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    },
  );
}

test('AttachedSessionDetail resumes following when wheeled back to the bottom during growth', async () => {
  const { browser, page, errors } = await attachedFixture();
  try {
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 1700,
    );
    await page.locator('#scroll').hover();
    await page.mouse.wheel(0, -12);
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 1688,
    );
    await page.mouse.wheel(0, 12);
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 1700,
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await page.getByRole('button', { name: 'Jump to latest' }).isVisible(),
    ).toBe(true);
    // Interleave one resize before the hook receives two of the native tail
    // scrolls, so tail intent cannot depend on timer luck.
    await page.locator('#scroll').evaluate((element) => {
      let previousTop = element.scrollTop;
      window.addEventListener(
        'scroll',
        (event) => {
          if (event.target !== element) return;
          const movedDown = element.scrollTop > previousTop;
          previousTop = element.scrollTop;
          if (element.dataset.interleave !== 'true' || !movedDown) return;
          element.dataset.interleave = 'false';
          const content = document.querySelector<HTMLElement>('#content')!;
          content.style.height = `${content.offsetHeight + 20}px`;
        },
        { capture: true },
      );
    });
    await startGrowth(page, 100, 20);
    await page.locator('#scroll').hover();
    for (let trip = 0; trip < 3; trip++) {
      const top = await page
        .locator('#scroll')
        .evaluate((element) => element.scrollTop);
      await page.mouse.wheel(0, -300);
      await page.waitForFunction(
        (before) => document.querySelector('#scroll')!.scrollTop < before - 100,
        top,
      );
      await page.waitForTimeout(150);
      if (trip > 0)
        await page.locator('#scroll').evaluate((element) => {
          element.dataset.interleave = 'true';
        });
      await page.mouse.wheel(0, 10000);
      await page.waitForFunction(
        (before) => document.querySelector('#scroll')!.scrollTop > before,
        top,
      );
      await page.waitForTimeout(220);
      if (trip > 0)
        expect(
          await page.locator('#scroll').getAttribute('data-interleave'),
        ).toBe('false');
      expect(await tailGap(page)).toBe(0);
      expect(
        await page.getByRole('button', { name: 'Jump to latest' }).isVisible(),
      ).toBe(false);
    }
    await finishGrowth(page);
    expect(await tailGap(page)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('a 30px upward wheel escapes follow during growth', async () => {
  const { browser, page, errors } = await sessionFixture();
  try {
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 1700,
    );
    await page.locator('#scroll').evaluate((element) => {
      let previousTop = element.scrollTop;
      element.addEventListener('scroll', () => {
        if (element.scrollTop < previousTop && !element.dataset.readerTop) {
          element.dataset.readerTop = String(element.scrollTop);
        }
        previousTop = element.scrollTop;
      });
    });
    await page.locator('#scroll').hover();
    await startGrowth(page, 100, 10);
    await page.mouse.wheel(0, -30);
    await finishGrowth(page);
    const readerTop = await page
      .locator('#scroll')
      .getAttribute('data-reader-top');
    expect(readerTop).not.toBeNull();
    expect(
      await page.locator('#scroll').evaluate((element) => element.scrollTop),
    ).toBe(Number(readerTop));
    expect(
      await page.getByRole('button', { name: 'Jump to latest' }).isVisible(),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('an upward clamp after content shrinks preserves follow for the next growth', async () => {
  const { browser, page, errors } = await sessionFixture();
  try {
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 1700,
    );
    await page.locator('#content').evaluate((element) => {
      element.style.height = '1600px';
    });
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 1300,
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.getByRole('button', { name: 'Grow' }).click();
    expect(await tailGap(page)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

const messageLeaf: Plugin = {
  name: 'attached-message-leaf',
  setup(builder) {
    builder.onResolve({ filter: /\/MessageBubble$/ }, () => ({
      path: 'message',
      namespace: 'attached-leaf',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'attached-leaf' }, () => ({
      contents: 'export const MessageBubble=({msg})=><div>{msg.content}</div>;',
      loader: 'tsx',
      resolveDir: process.cwd(),
    }));
  },
};

const attachedSession: OrchestrationSessionSummary = {
  threadId: 'external:claude:scroll-reader',
  provider: 'claude',
  status: 'running',
  createdAt: '2026-10-17T00:00:00Z',
  updatedAt: '2026-10-17T00:00:00Z',
  controlMode: 'read-only-attached',
  answerability: { answerable: true },
  isLoaded: true,
  isPersisted: true,
  eventCount: 2,
  attachedSource: {
    kind: 'claude-transcript',
    externalSessionId: 'scroll-reader',
    affinity: { kind: 'fixture-home', ref: 'scroll-reader' },
  },
};
const attachedEvents: CanonicalRuntimeEvent[] = [
  {
    eventId: 'start',
    provider: 'claude',
    threadId: attachedSession.threadId,
    createdAt: attachedSession.createdAt,
    method: 'turn.started',
    turnId: 'turn',
    prompt: 'Read this transcript',
  },
  {
    eventId: 'delta',
    provider: 'claude',
    threadId: attachedSession.threadId,
    createdAt: attachedSession.createdAt,
    method: 'content.text-delta',
    turnId: 'turn',
    itemId: 'answer',
    delta: 'Streaming answer',
  },
];

async function attachedFixture() {
  const fixture = await scrollBrowserFixture(
    `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
    import {ToastProvider} from './src-ui/src/contexts/ToastContext';
    import {useMobileVisualViewport} from './src-ui/src/hooks/useMobileVisualViewport';
    import {AttachedSessionDetail} from './src-ui/src/components/session-detail/AttachedSessionDetail';
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    function App(){return <QueryClientProvider client={client}><ToastProvider><AttachedSessionDetail apiBase="http://station.test" session={${JSON.stringify(attachedSession)}} events={${JSON.stringify(attachedEvents)}} connected={true} historyLoaded={true} onAdopted={()=>{}} getSelectionIntent={()=>0} visualViewport={useMobileVisualViewport()}/></ToastProvider></QueryClientProvider>}
    createRoot(document.getElementById('root')).render(<App/>);
  `,
    [messageLeaf],
  );
  await fixture.page.addStyleTag({
    content:
      '.chat-messages{height:300px;overflow:auto;overflow-anchor:none}.sessions-detail__transcript{height:2000px}',
  });
  await fixture.page.locator('.chat-messages').evaluate((element) => {
    element.id = 'scroll';
  });
  await fixture.page
    .locator('[data-testid="attached-session-transcript"]')
    .evaluate((element) => {
      element.id = 'content';
    });
  return fixture;
}

test('AttachedSessionDetail keeps following when a reader clicks its streaming transcript', async () => {
  const { browser, page, errors } = await attachedFixture();
  try {
    await page.waitForFunction(
      () => document.querySelector('.chat-messages')?.scrollTop === 1700,
    );
    await startGrowth(
      page,
      100,
      10,
      '[data-testid="attached-session-transcript"]',
    );
    await page.getByRole('log', { name: 'Conversation messages' }).click();
    await finishGrowth(page);
    expect(await tailGap(page, '.chat-messages')).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('native anchoring preserves a paused reader near the tail without resuming follow', async () => {
  const { browser, page, errors } = await sessionFixture();
  try {
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 1700,
    );
    await page.locator('#content').evaluate((content) => {
      const rows = Array.from({ length: 31 }, (_, index) => {
        const row = document.createElement('div');
        row.textContent = `Transcript row ${index}`;
        row.style.height = index === 0 ? '500px' : '50px';
        return row;
      });
      content.replaceChildren(...rows);
      content.style.height = 'auto';
    });
    await page.locator('#scroll').hover();
    await page.mouse.wheel(0, -12);
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 1688,
    );
    await page.waitForTimeout(100);
    await page.locator('#content').evaluate((content) => {
      (content.firstElementChild as HTMLElement).style.height = '520px';
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await page.locator('#scroll').evaluate((element) => element.scrollTop),
    ).toBe(1708);
    await startGrowth(page, 100, 10);
    await finishGrowth(page);
    expect(
      await page.locator('#scroll').evaluate((element) => element.scrollTop),
    ).toBe(1708);
    expect(
      await page.getByRole('button', { name: 'Jump to latest' }).isVisible(),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('a new session still opens at the tail after its loading content clamps the scroller', async () => {
  const { browser, page, errors } = await sessionFixture();
  try {
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 1700,
    );
    await page.getByRole('button', { name: 'Switch session' }).click();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await page.locator('#scroll').evaluate((element) => element.scrollTop),
    ).toBe(0);
    await page.getByRole('button', { name: 'Load', exact: true }).click();
    expect(
      await page.locator('#scroll').evaluate((element) => element.scrollTop),
    ).toBe(2100);
    expect(
      await page.getByRole('button', { name: 'Jump to latest' }).isVisible(),
    ).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test.each(['above', 'below'] as const)(
  'collapsing a transcript sibling %s preserves follow through the clamp and later growth',
  async (position) => {
    const { browser, page, errors } = await sessionFixture(position);
    try {
      await page.waitForFunction(
        () => document.querySelector('#scroll')?.scrollTop === 1900,
      );
      await page.locator(`#${position}`).evaluate((element) => {
        element.style.height = '0px';
      });
      await page.waitForFunction(
        () => document.querySelector('#scroll')?.scrollTop === 1700,
      );
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(
        await page.getByRole('button', { name: 'Jump to latest' }).isVisible(),
      ).toBe(false);
      await page.getByRole('button', { name: 'Grow' }).click();
      expect(await tailGap(page)).toBe(0);
      // Newly mounted errors/attention/details are outside the transcript ref.
      await page.locator(`#${position}`).evaluate((element) => {
        const card = document.createElement('div');
        card.style.height = '100px';
        element.replaceWith(card);
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(await tailGap(page)).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  },
);

test.each([
  { key: 'End', interval: 100, ticks: 15, up: 300 },
  { key: 'End', interval: 'frame' as const, ticks: 90, up: 300 },
  { key: 'ArrowDown', interval: 100, ticks: 15, up: 12 },
  { key: 'PageDown', interval: 100, ticks: 15, up: 100 },
  { key: 'Space', interval: 100, ticks: 15, up: 100 },
])(
  '$key resumes follow during $interval growth',
  async ({ key, interval, ticks, up }) => {
    const { browser, page, errors } = await sessionFixture();
    try {
      await page.waitForFunction(
        () => document.querySelector('#scroll')?.scrollTop === 1700,
      );
      await page.locator('#scroll').focus();
      await page.locator('#scroll').hover();
      await page.mouse.wheel(0, -up);
      await page.waitForFunction(
        (up) => document.querySelector('#scroll')?.scrollTop === 1700 - up,
        up,
      );
      expect(
        await page.getByRole('button', { name: 'Jump to latest' }).isVisible(),
      ).toBe(true);
      await startGrowth(page, interval, ticks);
      await page.keyboard.press(key);
      await page.waitForTimeout(500);
      expect(await tailGap(page)).toBe(0);
      expect(
        await page.getByRole('button', { name: 'Jump to latest' }).isVisible(),
      ).toBe(false);
      await finishGrowth(page);
      expect(await tailGap(page)).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  },
);

test('DOM growth keeps follow pinned at the next microtask before ResizeObserver delivery', async () => {
  const { browser, page, errors } = await sessionFixture();
  try {
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 1700,
    );
    const gap = await page.locator('#content').evaluate(async (content) => {
      content.style.height = `${content.offsetHeight + 20}px`;
      await Promise.resolve();
      const scroll = document.querySelector('#scroll')!;
      return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    });
    expect(gap).toBe(0);
    expect(
      await page.getByRole('button', { name: 'Jump to latest' }).isVisible(),
    ).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test.each(['above', 'below'] as const)(
  'collapsing a sibling %s while paused does not resume follow',
  async (position) => {
    const { browser, page, errors } = await sessionFixture(position);
    try {
      await page.waitForFunction(
        () => document.querySelector('#scroll')?.scrollTop === 1900,
      );
      await page.locator('#scroll').hover();
      await page.mouse.wheel(0, -300);
      await page.waitForFunction(
        () => document.querySelector('#scroll')?.scrollTop === 1600,
      );
      await page.locator(`#${position}`).evaluate((element) => {
        element.style.height = '0px';
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const pausedTop = await page
        .locator('#scroll')
        .evaluate((element) => element.scrollTop);
      expect(
        await page.getByRole('button', { name: 'Jump to latest' }).isVisible(),
      ).toBe(true);
      await page.getByRole('button', { name: 'Grow' }).click();
      expect(
        await page.locator('#scroll').evaluate((element) => element.scrollTop),
      ).toBe(pausedTop);
      expect(
        await page.getByRole('button', { name: 'Jump to latest' }).isVisible(),
      ).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  },
);
