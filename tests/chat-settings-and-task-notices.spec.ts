import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AccountPreferencesView } from '@kontourai/station-contracts/account-preferences';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { ConversationOpenResolution } from '@kontourai/station-contracts/orchestration';
import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { build } from 'esbuild';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';
import {
  DEFAULT_CONVERSATION_LOOKUPS,
  DEFAULT_CONVERSATIONS,
  dismissSetupLauncher,
  emitMockOrchestrationEvent,
  installMockOrchestrationConversationEventWindow,
  installMockOrchestrationEventWindow,
  installMockOrchestrationSse,
  openChatRegion,
  seedActiveChats,
  seedOrchestrationRoutes,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';

/**
 * The phone chat's Chat Settings dialog keeps Done reachable, and a
 * backgrounded task's settle reads as a compact status line, through the real
 * dock at a phone and a desktop width. Child-work settles arrive through the
 * mock orchestration SSE seam (`emitMockOrchestrationEvent`), the same path
 * the live `child-work.updated` stream takes.
 */

// The shared orchestration fixture's conversation (DEFAULT_CONVERSATION_LOOKUPS).
const SESSION_ID = 'session-1';
const CONVERSATION_ID = 'conv-1';
const PHONE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1280, height: 800 } as const;

async function seedChat(page: Page, several = false) {
  const preferences: AccountPreferencesView = {
    schemaVersion: 1,
    values: { developerToolsEnabled: true },
  };
  await page.route(/\/api\/me\/preferences(?:\?.*)?$/, (route) => {
    if (route.request().method() === 'PATCH') {
      preferences.values = {
        ...preferences.values,
        ...route.request().postDataJSON(),
      };
    }
    return route.fulfill({ json: { success: true, data: preferences } });
  });
  // Presence reporting is outside this journey; keep it off the shared server.
  await page.route('**/api/presence/focus', (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.addInitScript(() => {
    // Developer tools add the Event replay section, which is what makes the
    // panel taller than a phone screen.
    localStorage.setItem(
      'station-device-settings-v1',
      JSON.stringify({ version: 2, values: { developerToolsEnabled: true } }),
    );
  });
  await seedActiveChats(
    page,
    (several ? [1, 2] : [1]).map((index) => ({
      sessionId: `session-${index}`,
      conversationId: `conv-${index}`,
      title: `Working chat ${index}`,
      agentSlug: 'dev-agent',
      model: 'claude-sonnet',
      provider: 'codex',
      projectSlug: 'dev',
      orchestrationSessionStarted: true,
      ephemeralMessages: [],
      inputHistory: [],
    })),
  );
  await installMockOrchestrationSse(page);
  await seedOrchestrationRoutes(
    page,
    several
      ? {
          conversations: [
            ...DEFAULT_CONVERSATIONS,
            {
              id: 'conv-2',
              title: 'Working chat 2',
              createdAt: '2026-10-14T08:00:00.000Z',
              updatedAt: '2026-10-14T08:00:00.000Z',
              messageCount: 0,
            },
          ],
          conversationLookups: {
            ...DEFAULT_CONVERSATION_LOOKUPS,
            'conv-2': {
              id: 'conv-2',
              currentSessionId: 'session-2',
              agentSlug: 'dev-agent',
              projectSlug: 'dev',
              title: 'Working chat 2',
            },
          },
        }
      : undefined,
  );
  await installMockOrchestrationEventWindow(page, 'codex', {
    [SESSION_ID]: [
      {
        method: 'turn.started',
        provider: 'codex',
        threadId: SESSION_ID,
        turnId: 'turn-0',
        createdAt: '2026-10-14T08:00:00.000Z',
        prompt: 'Capture the mismatch screen',
      },
      {
        method: 'turn.completed',
        provider: 'codex',
        threadId: SESSION_ID,
        turnId: 'turn-0',
        createdAt: '2026-10-14T08:00:01.000Z',
        outputText: 'Started the captures in the background.',
      },
    ],
  });
  await installMockOrchestrationConversationEventWindow(
    page,
    (conversationId) =>
      conversationId === CONVERSATION_ID
        ? [SESSION_ID]
        : several && conversationId === 'conv-2'
          ? ['session-2']
          : [],
  );
  await page.route('**/api/orchestration/sessions/read-model', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: (several ? [1, 2] : [1]).map((index) => ({
          threadId: `session-${index}`,
          provider: 'codex',
          status: 'running',
          lifecycleState: 'running',
          hasActiveTurn: false,
          controlMode: 'station-owned',
          answerability: { answerable: true },
          isLoaded: true,
          isPersisted: true,
          eventCount: 2,
          createdAt: '2026-10-14T08:00:00.000Z',
          updatedAt: '2026-10-14T08:00:01.000Z',
        })),
      },
    }),
  );
}

async function openChat(page: Page, viewport: { width: number }) {
  const layoutsReady = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/projects/dev/layouts',
  );
  const chat = encodeURIComponent(CONVERSATION_ID);
  if (viewport.width === PHONE.width) {
    // A phone holds Chat in the maximized dock, not a layout region.
    await page.goto(`/?dock=open&maximize=true&chat=${chat}`);
    await dismissSetupLauncher(page);
  } else {
    await page.goto(`/projects/dev/layouts/code?chat=${chat}`);
    await dismissSetupLauncher(page);
    await openChatRegion(page);
  }
  await waitForMockOrchestrationSse(page);
  await expect(
    page.getByRole('log', { name: 'Conversation transcript' }),
  ).toContainText('Started the captures in the background.');
  await (await layoutsReady).finished();
  // Conversation authority adds the inventory and copy-session menu rows.
  await expect(
    page.getByRole('button', { name: 'Composer actions', exact: true }),
  ).toBeVisible();
}

async function openChatSettings(page: Page): Promise<Locator> {
  const phoneActions = page.getByRole('button', {
    name: 'Chat actions',
    exact: true,
  });
  if (await phoneActions.isVisible()) await phoneActions.click();
  else await page.getByRole('button', { name: 'More dock actions' }).click();
  await page.getByRole('menuitem', { name: 'Chat settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Chat Settings' });
  await expect(dialog).toBeVisible();
  await dialog.evaluate((element) =>
    Promise.all(
      element.getAnimations({ subtree: true }).map((a) => a.finished),
    ),
  );
  return dialog;
}

/** The settle shape a Claude backgrounded Bash reports (its summary quotes the title); child-work events are engine-agnostic. */
async function settle(
  page: Page,
  childId: string,
  status: 'completed' | 'failed' | 'cancelled',
  title: string,
  summary?: string,
) {
  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: {
      provider: 'codex',
      threadId: SESSION_ID,
      createdAt: '2026-10-14T08:05:00.000Z',
      method: 'child-work.updated',
      delta: {
        kind: 'settle',
        producer: 'engine-subagent',
        reporterThreadId: SESSION_ID,
        childId,
        status,
        result: summary
          ? { summary }
          : {
              handle: {
                kind: 'transcript-file',
                path: `/tmp/claude/tasks/${childId}.output`,
              },
            },
        identity: { title, backgrounded: true },
      },
    },
  });
}

async function evidence(page: Page, name: string, testInfo: TestInfo) {
  await page.screenshot({ path: testInfo.outputPath(name) });
}

for (const [label, viewport] of [
  ['phone', PHONE],
  ['desktop', DESKTOP],
] as const) {
  test.describe(`chat settings and task notices (${label})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
      await seedChat(page);
    });

    test('Done stays visible and hittable while the settings panel is scrolled anywhere', async ({
      page,
    }, testInfo) => {
      await openChat(page, viewport);
      const dialog = await openChatSettings(page);
      const done = dialog.getByRole('button', { name: 'Done' });

      const hittable = async () => {
        const box = await done.boundingBox();
        const panel = await dialog.boundingBox();
        expect(box && panel).toBeTruthy();
        // Fully inside the panel and the viewport…
        expect(box!.y).toBeGreaterThanOrEqual(panel!.y);
        expect(box!.y + box!.height).toBeLessThanOrEqual(
          panel!.y + panel!.height + 0.5,
        );
        expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
        // …and nothing else draws over its centre.
        const topmost = await page.evaluate(
          ([x, y]) => {
            const hit = document.elementFromPoint(x, y);
            return hit?.closest('button')?.textContent ?? null;
          },
          [box!.x + box!.width / 2, box!.y + box!.height / 2] as const,
        );
        expect(topmost).toBe('Done');
      };

      const scroller = await dialog.evaluate((element) => ({
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }));
      if (label === 'phone') {
        // Reachability: on a phone the panel must overflow, or "Done is
        // visible without scrolling" would be true of the old layout too.
        expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
      }
      await hittable();
      await evidence(page, `chat-settings-${label}-top.png`, testInfo);

      await dialog.evaluate((element) => element.scrollTo(0, 99_999));
      await hittable();
      await evidence(page, `chat-settings-${label}-bottom.png`, testInfo);

      // The import control is a styled button, not the native file chrome.
      await expect(
        dialog.getByRole('button', { name: 'Import replay file…' }),
      ).toBeVisible();
      await expect(dialog.locator('input[type="file"]')).toHaveCSS(
        'clip',
        'rect(0px, 0px, 0px, 0px)',
      );

      await done.click();
      await expect(dialog).toBeHidden();
    });

    test('settled background tasks read as compact, distinct status lines', async ({
      page,
    }, testInfo) => {
      await openChat(page, viewport);
      const transcript = page.getByRole('log', {
        name: 'Conversation transcript',
      });
      await expect(transcript).toContainText(
        'Started the captures in the background.',
      );

      const finishedTitle = 'Capture the mismatch screen once';
      const failedTitle = 'Capture the screen five times and save images';
      await settle(
        page,
        'bg-ok',
        'completed',
        finishedTitle,
        `Background command "${finishedTitle}" completed (exit code 0)`,
      );
      await settle(
        page,
        'bg-fail',
        'failed',
        failedTitle,
        `Background command "${failedTitle}" failed with exit code 1`,
      );
      await settle(page, 'bg-stop', 'cancelled', 'List open issues');

      const notices = page.getByTestId('background-task-notice');
      await expect(notices).toHaveCount(3);
      const [finished, failed, stopped] = [
        notices.nth(0),
        notices.nth(1),
        notices.nth(2),
      ];
      await expect(finished).toContainText('Task finished');
      await expect(failed).toContainText('Task failed');
      await expect(stopped).toContainText('Task stopped');

      // Distinct treatment: success and failure do not share a colour.
      const colour = (notice: Locator) =>
        notice
          .locator('.task-notice__status')
          .evaluate((element) => getComputedStyle(element).color);
      expect(await colour(finished)).not.toBe(await colour(failed));

      const visible = await finished.evaluate(
        (element) => (element as HTMLElement).innerText,
      );
      expect(visible.split(finishedTitle)).toHaveLength(2);
      await expect(finished.locator('details')).not.toHaveAttribute('open');
      await expect(failed.locator('details')).toHaveCount(0);
      await expect(
        failed.getByText(
          `Background command "${failedTitle}" failed with exit code 1`,
        ),
      ).toBeVisible();
      await expect(stopped).not.toContainText('⏹');

      await notices.last().scrollIntoViewIfNeeded();
      await evidence(page, `task-notices-${label}.png`, testInfo);

      await finished.getByText('Details').click();
      await expect(finished).toContainText('completed (exit code 0)');
      await evidence(page, `task-notices-${label}-details.png`, testInfo);
    });
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`Done hover keeps readable contrast (${theme})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(PHONE);
    await seedChat(page);
    await page.addInitScript((theme) => {
      localStorage.setItem(
        'station-device-settings-v1',
        JSON.stringify({
          version: 2,
          values: { developerToolsEnabled: true, theme },
        }),
      );
    }, theme);
    await openChat(page, PHONE);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const dialog = await openChatSettings(page);
    const done = dialog.getByRole('button', { name: 'Done', exact: true });
    await done.hover();
    const contrast = await done.evaluate((element) => {
      const style = getComputedStyle(element);
      const luminance = (color: string) => {
        const channels = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((value) => {
            const channel = value / 255;
            return channel <= 0.04045
              ? channel / 12.92
              : ((channel + 0.055) / 1.055) ** 2.4;
          });
        return (
          channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
        );
      };
      const foreground = luminance(style.color);
      const background = luminance(style.backgroundColor);
      return (
        (Math.max(foreground, background) + 0.05) /
        (Math.min(foreground, background) + 0.05)
      );
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await evidence(page, `chat-settings-${theme}-hover.png`, testInfo);
    await done.click();
    await expect(dialog).toBeHidden();
  });
}

async function openWorkingChat(page: Page, several = false) {
  await page.setViewportSize(DESKTOP);
  await seedChat(page, several);
  await page.goto('/?dock=open&maximize=true&chat=conv-1');
  await dismissSetupLauncher(page);
  await waitForMockOrchestrationSse(page);
  await expect(
    page.getByRole('log', { name: 'Conversation transcript' }),
  ).toContainText('Started the captures in the background.');
  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: {
      provider: 'codex',
      threadId: SESSION_ID,
      method: 'turn.started',
      turnId: 'keyboard-active',
      createdAt: new Date().toISOString(),
      prompt: 'Working chat',
    },
  });
  const activity = page.getByRole('button', {
    name: '1 chat working',
    exact: true,
  });
  await expect(activity).toHaveAttribute('title', '1 chat working');
  return activity;
}

for (const key of ['Enter', 'Space']) {
  test(`working chat indicator toggles with ${key}`, async ({ page }) => {
    const activity = await openWorkingChat(page);
    await activity.focus();
    await expect(activity).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press(key);
    await expect(activity).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(activity).toHaveAttribute('aria-expanded', 'false');
  });
}

test('working chat selection keeps composer focus when its turn completes', async ({
  page,
}, testInfo) => {
  const activity = await openWorkingChat(page);
  await activity.focus();
  await page.keyboard.press('Enter');
  await expect(activity).toHaveAttribute('aria-expanded', 'true');
  const chats = page.getByRole('menu', { name: /chats? working/ });
  await expect(chats).toBeVisible();
  await expect(chats.getByRole('menuitem').first()).toBeFocused();
  await evidence(page, 'working-chat-keyboard.png', testInfo);
  await page.keyboard.press('Escape');
  await expect(chats).toBeHidden();
  await expect(activity).toBeFocused();
  await page.keyboard.press('Space');
  await expect(chats).toBeVisible();
  await expect(chats.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(chats).toBeHidden();
  const composer = page.locator('.chat-input textarea');
  await expect(composer).toBeFocused();

  await activity.click();
  await expect(chats).toBeVisible();
  await page
    .getByRole('button', { name: 'Close 1 chat working', exact: true })
    .click();
  await expect(chats).toBeHidden();
  await activity.focus();
  await page.keyboard.press('Enter');
  await expect(chats.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(composer).toBeFocused();
  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: {
      provider: 'codex',
      threadId: SESSION_ID,
      method: 'turn.completed',
      turnId: 'keyboard-active',
      createdAt: new Date().toISOString(),
      outputText: 'Working chat completed.',
    },
  });
  await expect(activity).toHaveCount(0);
  await expect(composer).toBeFocused();
});

test('working chat selection focuses the selected composer among several chats', async ({
  page,
}) => {
  await openWorkingChat(page, true);
  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: {
      provider: 'codex',
      threadId: 'session-2',
      method: 'turn.started',
      turnId: 'second-active',
      createdAt: new Date().toISOString(),
      prompt: 'Second working chat',
    },
  });
  const activity = page.getByRole('button', {
    name: '2 chats working',
    exact: true,
  });
  await expect(activity).toBeVisible();
  await activity.focus();
  await page.keyboard.press('Enter');
  const selected = page
    .getByRole('menu', { name: /chats? working/ })
    .getByRole('menuitem', { name: /Working chat 2/ });
  await selected.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/chat=conv-2/);
  const composer = page.locator('.chat-input textarea');
  await expect(composer).toBeFocused();
  await composer.fill('Draft for the selected chat');
  await expect(composer).toHaveValue('Draft for the selected chat');
});

async function selectDelayedWorkingChat(page: Page, readOnly = false) {
  await openWorkingChat(page, true);
  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: {
      provider: 'codex',
      threadId: 'session-2',
      method: 'turn.started',
      turnId: 'second-active',
      createdAt: new Date().toISOString(),
      prompt: 'Second working chat',
    },
  });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markRequested = () => {};
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  await page.route('**/api/conversations/conv-2/open', async (route) => {
    markRequested();
    await held;
    if (readOnly) {
      return route.fulfill({
        json: {
          success: true,
          data: {
            status: 'resolved',
            currentSessionId: 'session-2',
            canContinue: false,
            conversation: {
              id: 'conv-2',
              source: 'runtime',
              title: 'Working chat 2',
              agentSlug: agentId('dev-agent'),
              projectSlug: 'dev',
              mutable: false,
              answerability: { answerable: true },
              createdAt: '2026-10-14T08:00:00.000Z',
              updatedAt: '2026-10-14T08:00:00.000Z',
              messageCount: 0,
            },
            transcript: { available: true, owner: 'runtime', messageCount: 0 },
            recoveryActions: [],
            execution: {
              sessionId: 'session-2',
              agentId: agentId('dev-agent'),
              provider: 'codex',
            },
            answerability: { answerable: true },
          } satisfies ConversationOpenResolution,
        },
      });
    }
    await route.fallback();
  });
  const activity = page.getByRole('button', {
    name: '2 chats working',
    exact: true,
  });
  await activity.focus();
  await page.keyboard.press('Enter');
  await page
    .getByRole('menu', { name: /chats? working/ })
    .getByRole('menuitem', { name: /Working chat 2/ })
    .focus();
  await page.keyboard.press('Enter');
  const composer = page.locator('.chat-input textarea');
  try {
    await requested;
    await expect(page).toHaveURL(/chat=conv-2/);
    await expect(composer).toBeDisabled();
  } catch (error) {
    release();
    throw error;
  }
  return { composer, release };
}

async function finishDelayedOpen(
  page: Page,
  composer: Locator,
  release: () => void,
) {
  release();
  await expect(composer).toBeEnabled();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

test('delayed working chat selection preserves deliberate Station home focus', async ({
  page,
}) => {
  const { composer, release } = await selectDelayedWorkingChat(page);
  try {
    const home = page.getByRole('button', {
      name: 'Station home',
      exact: true,
    });
    await home.focus();
    await expect(home).toBeFocused();
    await finishDelayedOpen(page, composer, release);
    await expect(home).toBeFocused();
  } finally {
    release();
  }
});

test('delayed working chat request stays cancelled after keyboard reselection', async ({
  page,
}) => {
  const { composer, release } = await selectDelayedWorkingChat(page);
  try {
    await page.keyboard.press('ControlOrMeta+1');
    await expect(page).toHaveURL(/chat=conv-1/);
    await page.keyboard.press('ControlOrMeta+2');
    await expect(page).toHaveURL(/chat=conv-2/);
    await expect(composer).toBeDisabled();
    await finishDelayedOpen(page, composer, release);
    await expect(composer).not.toBeFocused();
  } finally {
    release();
  }
});

test('delayed working chat selection restores composer focus after resizing to 390px', async ({
  page,
}) => {
  const { composer, release } = await selectDelayedWorkingChat(page);
  try {
    await page.setViewportSize(PHONE);
    await expect(
      page.getByRole('button', { name: 'Chat actions', exact: true }),
    ).toBeVisible();
    // Keep opening pending beyond the former 60-frame retry window.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          let frames = 0;
          const tick = () => {
            if (++frames === 75) resolve();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
    await expect(composer).toBeDisabled();
    await finishDelayedOpen(page, composer, release);
    await expect(composer).toBeFocused();
  } finally {
    release();
  }
});

test('later textarea enable fulfils the working chat focus request', async ({
  page,
}) => {
  // The mounted owner changes conversation readiness and textarea enabled state
  // separately, through keyboard actions; ChatInputArea reports its real state.
  const script = (
    await build({
      stdin: {
        resolveDir: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
        loader: 'tsx',
        contents: `
import React,{useRef,useState} from 'react';import{createRoot}from'react-dom/client';
import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import{ChatInputArea}from'./src-ui/src/components/chat/ChatInputArea';
import{PreviewProvider}from'./src-ui/src/contexts/PreviewContext';
import{useWorkingChatFocus}from'./src-ui/src/hooks/useWorkingChatFocus';
const base={attachments:[],isSending:false,turnInFlight:false,modelSupportsAttachments:true,fontSize:14,dockHeight:500,canModelSelect:false,availableModels:[],modelQuery:null,commandQuery:null,slashCommands:[],onCancel:()=>{},onClearInput:()=>{},onRemoveAttachment:()=>{},onClearAttachments:()=>{},onModelSelect:()=>{},onModelReset:()=>{},onModelClose:()=>{},onModelOpen:()=>{},onModelRuntimeOptionChange:()=>{},onApprovalModeChange:()=>{},onCommandSelect:async()=>{},onCommandClose:()=>{},onHistoryUp:()=>{},onHistoryDown:()=>{},updateFromInput:()=>{},closeAll:()=>{}};
function App(){
 const ref=useRef(null),surfaceRef=useRef(null);
 const[ready,setReady]=useState(false),[disabled,setDisabled]=useState(true),[input,setInput]=useState('');
 const{requestComposerFocus,onComposerEnabledChange}=useWorkingChatFocus({activeSessionId:'selected',ready,terminal:false,surfaceRef});
 return <main ref={surfaceRef} onKeyDown={e=>{if(e.key==='F7')setReady(true);if(e.key==='F8')setDisabled(false)}}>
 <div className="chat-dock__activity"><button onClick={()=>requestComposerFocus('selected')}>Select working chat</button></div>
 <output>{ready?'Conversation ready':'Opening conversation'}</output>
 <ChatInputArea {...base} sessionId="selected" input={input} onInputChange={setInput} onSend={async()=>{}} disabled={disabled} textareaRef={ref} onEnabledChange={onComposerEnabledChange}/>
 </main>;
}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><PreviewProvider><App/></PreviewProvider></QueryClientProvider>);
`,
      },
      bundle: true,
      format: 'iife',
      jsx: 'automatic',
      write: false,
      platform: 'browser',
      define: {
        'process.env.NODE_ENV': '"production"',
        'import.meta.env.DEV': 'false',
      },
      loader: { '.css': 'empty' },
    })
  ).outputFiles[0].text;
  await page.route(
    'http://station.test/api/**',
    rejectUnexpectedFixtureRequest,
  );
  await page.route('http://station.test/', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://station.test/');
  await page.addScriptTag({ content: script });
  await page.getByRole('button', { name: 'Select working chat' }).click();
  const composer = page.locator('textarea');
  await page.keyboard.press('F7');
  await expect(
    page.getByText('Conversation ready', { exact: true }),
  ).toBeVisible();
  await expect(composer).toBeDisabled();
  await page.keyboard.press('F8');
  await expect(composer).toBeEnabled();
  await expect(composer).toBeFocused();
  await composer.fill('Draft after the later enable');
  await expect(composer).toHaveValue('Draft after the later enable');
});

test('read-only working chat selection focuses its transcript', async ({
  page,
}) => {
  const { composer, release } = await selectDelayedWorkingChat(page, true);
  try {
    release();
    await expect(page.getByText(/read-only/).first()).toBeVisible();
    await expect(composer).toBeDisabled();
    await expect(
      page.getByRole('log', { name: 'Conversation transcript' }),
    ).toBeFocused();
  } finally {
    release();
  }
});

for (const expired of [false, true]) {
  test(`working chat focus ${expired ? 'expires after its bounded lifetime' : 'survives a slow remote open'}`, async ({
    page,
  }) => {
    await page.clock.install();
    const { composer, release } = await selectDelayedWorkingChat(page);
    try {
      await page.clock.fastForward(expired ? 60_001 : 59_000);
      await finishDelayedOpen(page, composer, release);
      if (expired) await expect(composer).not.toBeFocused();
      else await expect(composer).toBeFocused();
    } finally {
      release();
    }
  });
}

test('approval dialog cancels pending working chat focus at phone width', async ({
  page,
}) => {
  const { composer, release } = await selectDelayedWorkingChat(page);
  try {
    await page.setViewportSize(PHONE);
    await emitMockOrchestrationEvent(
      page,
      'orchestration:event',
      {
        event: {
          provider: 'codex',
          threadId: 'session-2',
          method: 'request.opened',
          turnId: 'second-active',
          eventId: 'focus-approval',
          requestId: 'focus-approval',
          requestType: 'approval',
          title: 'Allow protected write',
          createdAt: new Date().toISOString(),
          payload: { toolName: 'shell', command: 'write protected file' },
        },
      },
      { sequence: 2 },
    );
    const dialog = page.getByRole('dialog', {
      name: /Needs approval|Allow protected write/,
    });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole('button', { name: 'Close and answer later' })
      .click();
    await expect(dialog).toBeHidden();
    await finishDelayedOpen(page, composer, release);
    await expect(composer).not.toBeFocused();
    await expect(dialog).toBeHidden();
  } finally {
    release();
  }
});

test('replay working chat selection focuses its transcript', async ({
  page,
}) => {
  await openWorkingChat(page, true);
  await page.route(
    /\/api\/orchestration\/sessions\/(?:session-1|conv-1)\/event-page(?:\?.*)?$/,
    (route) => {
      const threadId = decodeURIComponent(
        new URL(route.request().url()).pathname.split('/').at(-2)!,
      );
      const base = {
        provider: 'codex',
        threadId,
        createdAt: '2026-10-14T08:00:00.000Z',
      };
      const events = [
        {
          ...base,
          eventId: 'replay-start',
          method: 'turn.started',
          turnId: 'replay-live',
          prompt: 'Replay working turn',
        },
        {
          ...base,
          eventId: 'replay-delta1',
          method: 'content.text-delta',
          turnId: 'replay-live',
          itemId: 'replay-answer',
          delta: 'Replay answer ',
        },
        {
          ...base,
          eventId: 'replay-delta2',
          method: 'content.text-delta',
          turnId: 'replay-live',
          itemId: 'replay-answer',
          delta: 'still working.',
        },
      ];
      return route.fulfill({
        json: {
          success: true,
          data: {
            session: { model: 'claude-sonnet' },
            events: events.map((event, index) => ({
              sequence: index + 1,
              event,
            })),
            nextSequence: 3,
            hasMore: false,
          },
        },
      });
    },
  );
  const settings = await openChatSettings(page);
  await settings
    .getByRole('button', { name: 'Step through this conversation' })
    .click();
  const transport = page.getByTestId('replay-transport');
  await expect(transport).toBeVisible();
  await transport.getByText('Replay controls · 0 / 3', { exact: true }).click();
  const step = transport.getByRole('button', { name: 'Step', exact: true });
  await step.click();
  await step.click();
  await step.click();
  const activity = page.getByRole('button', {
    name: /chats? working/,
    exact: true,
  });
  await activity.focus();
  await page.keyboard.press('Enter');
  const replay = page
    .getByRole('menu', { name: /chats? working/ })
    .getByRole('menuitem', { name: /Event replay/ });
  await expect(replay).toBeVisible();
  await replay.focus();
  await page.keyboard.press('Enter');
  await expect(transport).toBeVisible();
  await expect(page.locator('.chat-input textarea')).toHaveCount(0);
  await expect(
    page.getByRole('log', { name: 'Conversation transcript' }),
  ).toBeFocused();
});
