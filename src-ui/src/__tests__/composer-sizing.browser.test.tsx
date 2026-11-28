import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Plugin } from 'esbuild';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

const cascade = [
  'src-ui/src/index.css',
  'src-ui/src/components/chat/chat.css',
  'src-ui/src/components/chat-dock/AgentScheduleNotes.css',
]
  .map((path) => resolveCssImports(resolve(path)))
  .join('\n');

// Controls unrelated to draft sizing have no API provider in this fixture.
const controls: Plugin = {
  name: 'composer-controls',
  setup(builder) {
    const modules: Record<string, string> = {
      useAgentSchedule: `export const useAgentSchedule=()=>({schedule:{wakeUps:[{id:'wake',dueAt:'2026-11-15T23:00:00Z',state:window.checkBackNeedsApproval?'needs_approval':'pending',note:'Check results'}],jobProposals:[],automationProposals:[]},loaded:true,cancelWakeUp:{mutate(){}},approveWakeUp:{},declineWakeUp:{},declineProposal:{},approveProposal:{},confirmAutomationProposal:{},declineAutomationProposal:{}});`,
      DeviceSettingsContext:
        'export const useDeviceSettings = () => ({chatReturnBehavior:"newline"});',
      KeyboardShortcutsContext: 'export const setShortcutContext = () => {};',
      UnconfirmedDiscardConfirm:
        'export const UnconfirmedDiscardConfirm=()=>null; export const useUnconfirmedDiscardDisclosure=()=>({});',
    };
    const names = [
      'ApprovalModeChip',
      'ComposerActionsMenu',
      'VoiceOrb',
      'ComposerIconAction',
      'ComposerStopButton',
      'PortableDraftsMenu',
      'FileMentionAutocomplete',
      'SessionReferencePicker',
      'ComposerAttachmentStrip',
      'FileAttachmentInput',
      'SlashCommandSelector',
      'ModelCatalogUnavailableState',
      'ComposerContextUsage',
      'ContextPercentage',
    ];
    for (const name of names) modules[name] = `export const ${name}=()=>null;`;
    modules.ModelSelector = 'export const ModelSelectorAutocomplete=()=>null;';
    builder.onResolve({ filter: /./ }, (args) => {
      const name = args.path.split('/').at(-1)!;
      return name in modules
        ? { path: name, namespace: 'controls' }
        : undefined;
    });
    builder.onLoad({ filter: /.*/, namespace: 'controls' }, (args) => ({
      contents: modules[args.path],
      loader: 'tsx',
    }));
  },
};

const composerFixture = `
    import React, {useRef,useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {ChatInputArea} from './src-ui/src/components/chat/ChatInputArea';
    import {AgentScheduleNotes} from './src-ui/src/components/chat-dock/AgentScheduleNotes';
    import {ScrollToBottomButton} from './src-ui/src/components/chat/ScrollToBottomButton';
    function App(){
      const [input,setInput] = useState('one\\ntwo\\nthree\\nfour\\nfive');
      const [composerShown,setComposerShown] = useState(!window.startComposerHidden);
      const textareaRef=useRef(null);
      const [pickerOpen,setPickerOpen]=useState(false);
      const [model,setModel]=useState('gpt-5.5');
      const [sessionMode,setSessionMode]=useState('build');
      const [sent,setSent]=useState('');
      const [selection,setSelection]=useState('');
      const busy=window.composerFixtureBusy;
      const modes=window.composerFixtureModels ? [{id:'build',name:'Build'},{id:'plan',name:'Plan'}] : [];
      const models=window.composerFixtureModels ? [
        {id:'gpt-5.5',name:'GPT-5.5'},
        {id:'gpt-5.6',name:'GPT-5.6'},
      ] : [];
      const noop=()=>{};
      return <>
        <style>{'.chat-dock__body[data-composer-hidden] > .chat-input { display: none; }'}</style>
        {!composerShown && <button onClick={()=>setComposerShown(true)}>Show composer</button>}
        <div className="chat-dock__body" data-composer-hidden={composerShown ? undefined : ''} style={{height:600,display:'flex',flexDirection:'column'}}>
        <div id="transcript" className="chat-messages" style={{flex:'1 1 0',minHeight:0,overflow:'auto',overflowAnchor:'none'}}><div style={{height:3000}}>Transcript</div></div>
        <output aria-label="Sent message" hidden={!sent}>{sent}</output>
        <output aria-label="Model selection focus" hidden={!selection}>{selection}</output>
        <ChatInputArea activity={<><AgentScheduleNotes conversationId="fixture" refreshKey="settled"/><ScrollToBottomButton onClick={noop}/></>} agentSlug="station" sessionId="fixture" input={input} textareaRef={textareaRef} attachments={[]} disabled={false} turnInFlight={!!busy} busyFollowUp={busy} busySteeringKind="native" busySteeringUnavailableReason={busy==='queue' ? 'The engine is finishing this turn.' : undefined} onQueueFollowUp={busy ? async()=>{setSent('queue');setInput('')} : undefined} modelSupportsAttachments={false} fontSize={14} dockHeight={600} apiBase="http://station.test" canModelSelect={models.length>0} availableModels={models} currentModel={models.length ? model : undefined} acpSessionModes={modes} acpCurrentModeId={sessionMode} onAcpSessionModeChange={setSessionMode} modelQuery={pickerOpen ? '' : null} commandQuery={null} slashCommands={[]} onInputChange={setInput} onSend={async(intent)=>{setSent(intent??input);setInput('')}} onCancel={noop} onClearInput={noop} selectAttachmentFiles={noop} onRemoveAttachment={noop} onClearAttachments={noop} onModelSelect={(choice)=>{setSelection(document.activeElement===textareaRef.current ? 'draft focused' : 'draft blurred');setModel(choice.id);setPickerOpen(false)}} onModelReset={noop} onModelClose={()=>setPickerOpen(false)} onModelOpen={()=>setPickerOpen(true)} onModelRuntimeOptionChange={noop} onApprovalModeChange={noop} onCommandSelect={noop} onCommandClose={noop} onHistoryUp={noop} onHistoryDown={noop} onShowStats={noop} updateFromInput={noop} closeAll={()=>setPickerOpen(false)}/>
        </div>
      </>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `;

test.each([
  { initiallyHidden: false, state: 'visible' },
  { initiallyHidden: true, state: 'initially hidden' },
])(
  'sizes $state draft content without transiently clamping the pinned transcript',
  async ({ initiallyHidden }) => {
    const { browser, page, errors } = await scrollBrowserFixture(
      composerFixture,
      [controls],
      {},
      async (page) => {
        if (initiallyHidden)
          await page.addInitScript('window.startComposerHidden = true;');
      },
    );
    try {
      await page.addStyleTag({ content: cascade });
      if (initiallyHidden) {
        expect(await page.locator('textarea').isVisible()).toBe(false);
        const hiddenMeasurements = await page
          .locator('.chat-input')
          .evaluate(async (element) => {
            let measurements = 0;
            const observer = new MutationObserver((records) => {
              for (const record of records)
                for (const node of record.addedNodes)
                  if (
                    node instanceof HTMLTextAreaElement &&
                    node.getAttribute('aria-hidden') === 'true'
                  )
                    measurements += 1;
            });
            observer.observe(element, { childList: true, subtree: true });
            const frames = async (count: number) => {
              for (let frame = 0; frame < count; frame += 1)
                await new Promise<void>((resolve) =>
                  requestAnimationFrame(() => resolve()),
                );
            };
            await frames(8);
            measurements = 0;
            await frames(12);
            observer.disconnect();
            return measurements;
          });
        expect(
          hiddenMeasurements,
          'settled hidden draft does not keep measuring itself',
        ).toBe(0);
        await page.getByRole('button', { name: 'Show composer' }).click();
      }
      await page.waitForSelector('textarea');
      await expect
        .poll(() =>
          page
            .locator('textarea')
            .evaluate(
              (element) => Number.parseFloat(element.style.height) || 0,
            ),
        )
        .toBeGreaterThan(0);
      expect(await page.locator('textarea').inputValue()).toBe(
        'one\ntwo\nthree\nfour\nfive',
      );
      expect(errors).toEqual([]);
      await page.locator('textarea').focus();
      await page.locator('textarea').press('ControlOrMeta+End');
      await page.locator('#transcript').evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const gap = () =>
        page
          .locator('#transcript')
          .evaluate(
            (element) =>
              element.scrollHeight - element.clientHeight - element.scrollTop,
          );
      expect(await gap()).toBe(0);
      await page.locator('textarea').press('x');
      expect(await gap()).toBeLessThanOrEqual(1);
      await page.locator('textarea').press('Backspace');
      expect(await gap()).toBeLessThanOrEqual(1);
      await page
        .locator('textarea')
        .fill(Array.from({ length: 30 }, () => 'line').join('\n'));
      const capped = await page.locator('textarea').evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        overflow: element.style.overflowY,
        content: element.scrollHeight,
        viewport: element.clientHeight,
      }));
      expect(capped.height).toBeCloseTo(160, 0);
      expect(capped.overflow).toBe('auto');
      expect(capped.content).toBeGreaterThan(capped.viewport);
      await page.locator('textarea').fill('short');
      const short = await page.locator('textarea').evaluate((element) => ({
        height: element.clientHeight,
        content: element.scrollHeight,
        overflow: element.style.overflowY,
      }));
      expect(short.height).toBeLessThan(80);
      expect(short.content).toBeLessThanOrEqual(short.height + 1);
      expect(short.overflow).toBe('hidden');
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  },
);

test.each([
  {
    needsApproval: false,
    name: 'scheduled check-back shares the activity row with Scroll to bottom',
  },
  {
    needsApproval: true,
    name: 'check-back approval keeps its button styles inside the composer',
  },
])('$name in both themes and widths', async ({ needsApproval }) => {
  const artifacts = resolve('.surface/inbox-chat-polish');
  await mkdir(artifacts, { recursive: true });
  for (const width of [390, 1440])
    for (const theme of ['dark', 'light']) {
      const { browser, page, errors } = await scrollBrowserFixture(
        composerFixture,
        [controls],
        { viewport: { width, height: 900 } },
        async (page) => {
          if (needsApproval)
            await page.addInitScript('window.checkBackNeedsApproval = true;');
        },
      );
      try {
        await page.addStyleTag({ content: cascade });
        await page.evaluate(
          (value) => (document.documentElement.dataset.theme = value),
          theme,
        );
        if (needsApproval) {
          const approve = page.getByRole('button', {
            name: 'Approve',
            exact: true,
          });
          const decline = page.getByRole('button', {
            name: 'Decline',
            exact: true,
          });
          await approve.waitFor();
          expect(
            await approve.evaluate(
              (button) => getComputedStyle(button).backgroundColor,
            ),
          ).not.toBe('rgba(0, 0, 0, 0)');
          expect(
            await decline.evaluate(
              (button) => getComputedStyle(button).borderTopStyle,
            ),
          ).toBe('solid');
          await page.keyboard.press('Tab');
          await approve.focus();
          expect(
            await approve.evaluate((button) =>
              button.matches(':focus-visible'),
            ),
          ).toBe(true);
          if (width === 390) {
            expect(
              (await approve.boundingBox())!.height,
            ).toBeGreaterThanOrEqual(44);
            expect(
              (await decline.boundingBox())!.height,
            ).toBeGreaterThanOrEqual(44);
          }
        } else {
          const note = page.getByText(/Checking back at/);
          await note.waitFor();
          const noteBox = (await note.boundingBox())!;
          const scroll = (await page
            .getByRole('button', { name: 'Scroll to bottom' })
            .boundingBox())!;
          expect(scroll.y).toBeLessThan(noteBox.y + noteBox.height);
          expect(scroll.y + scroll.height).toBeGreaterThan(noteBox.y);
          expect(scroll.x).toBeGreaterThan(noteBox.x + noteBox.width);
        }
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
        ).toBe(false);
        expect(errors).toEqual([]);
        await page.screenshot({
          path: resolve(
            artifacts,
            `${needsApproval ? 'approval' : 'scheduled'}-${width}-${theme}.png`,
          ),
          animations: 'disabled',
        });
      } finally {
        await browser.close();
      }
    }
});

test('viewport ticks resize a long draft without replacing the dock reservation observers', async () => {
  const { browser, page } = await scrollBrowserFixture(
    composerFixture,
    [controls],
    {},
    async (page) => {
      await page.addInitScript(`
      window.dockObserverDisconnects = 0;
      const watched = new WeakSet();
      for (const Observer of [ResizeObserver, MutationObserver]) {
        const observe = Observer.prototype.observe;
        const disconnect = Observer.prototype.disconnect;
        Observer.prototype.observe = function (target, ...options) {
          if (target.matches?.('.chat-dock__body, .chat-input')) watched.add(this);
          return observe.call(this, target, ...options);
        };
        Observer.prototype.disconnect = function () {
          if (watched.has(this)) window.dockObserverDisconnects++;
          disconnect.call(this);
        };
      }
    `);
    },
  );
  try {
    await page.addStyleTag({ content: cascade });
    const draft = page.locator('textarea');
    const composer = page.locator('.chat-input');
    await draft.fill(Array(30).fill('line').join('\n'));
    const draftHeight = () =>
      draft.evaluate((node) => Number.parseFloat(node.style.height));
    const reservation = () =>
      composer.evaluate((node) => Number.parseFloat(node.style.minHeight));
    await expect.poll(draftHeight).toBe(160);
    await expect.poll(reservation).toBeGreaterThan(0);
    const disconnects = () =>
      page.evaluate(() => Reflect.get(window, 'dockObserverDisconnects'));
    const initial = await disconnects();
    for (const height of [480, 420, 360]) {
      // Simulate only the visible viewport changing, as during an IME slide.
      await page.evaluate((height) => {
        Object.defineProperty(window.visualViewport, 'height', {
          configurable: true,
          value: height,
        });
        window.visualViewport?.dispatchEvent(new Event('resize'));
      }, height);
      await expect.poll(draftHeight).toBe(height * 0.3);
      expect(await reservation()).toBeGreaterThan(0);
    }
    expect(await disconnects()).toBe(initial);
  } finally {
    await browser.close();
  }
});

test('touch Send keeps focus through mobile submit concealment and keyboard Send still submits', async () => {
  const { browser, page } = await scrollBrowserFixture(
    composerFixture,
    [controls],
    { hasTouch: true, isMobile: true },
  );
  try {
    await page.addStyleTag({ content: cascade });
    const draft = page.locator('textarea');
    const send = page.getByRole('button', { name: 'Send', exact: true });
    const sent = page.getByLabel('Sent message');
    await draft.fill('Touch draft');
    await send.tap();
    await expect.poll(() => draft.inputValue()).toBe('');
    expect(await send.count()).toBe(0);
    expect(
      await draft.evaluate((node) => node === document.activeElement),
    ).toBe(true);
    expect(await sent.textContent()).toBe('Touch draft');

    for (const key of ['Enter', 'Space']) {
      await draft.fill(key);
      await send.focus();
      await page.keyboard.press(key);
      await expect.poll(() => sent.textContent()).toBe(key);
    }
  } finally {
    await browser.close();
  }
});

test.each(['steer', 'queue'])(
  'touching send mode with %s capability keeps the draft focused',
  async (busy) => {
    const { browser, page } = await scrollBrowserFixture(
      composerFixture,
      [controls],
      { hasTouch: true, isMobile: true },
      (page) =>
        page.addInitScript(
          (busy) => Reflect.set(window, 'composerFixtureBusy', busy),
          busy,
        ),
    );
    try {
      await page.addStyleTag({ content: cascade });
      const draft = page.locator('textarea');
      const mode = page.getByRole('button', { name: /^Send mode:/ });
      const dialog = page.getByRole('dialog', { name: 'Send mode' });
      await draft.tap();
      await mode.tap();
      expect(
        await draft.evaluate((node) => node === document.activeElement),
      ).toBe(true);
      if (busy === 'steer') {
        expect(await mode.getAttribute('aria-pressed')).toBe('true');
        expect(await dialog.count()).toBe(0);
        await mode.tap();
        expect(await mode.getAttribute('aria-pressed')).toBe('false');
        expect(
          await draft.evaluate((node) => node === document.activeElement),
        ).toBe(true);
      } else {
        await dialog.getByText('The engine is finishing this turn.').waitFor();
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        expect(
          await draft.evaluate((node) => node === document.activeElement),
        ).toBe(true);
      }
    } finally {
      await browser.close();
    }
  },
);

test('Run setup keeps touch focus, restores focus during model selection, and traps keyboard focus', async () => {
  const { browser, page } = await scrollBrowserFixture(
    composerFixture,
    [controls],
    { hasTouch: true, isMobile: true },
    (page) =>
      page.addInitScript(() =>
        Reflect.set(window, 'composerFixtureModels', true),
      ),
  );
  try {
    await page.addStyleTag({ content: cascade });
    const draft = page.locator('textarea');
    const trigger = page.getByTestId('run-setup-trigger');
    const setup = page.getByRole('dialog', { name: 'Agent & model' });
    await draft.tap();
    await trigger.tap();
    await setup.waitFor();
    expect(await setup.getAttribute('aria-modal')).toBeNull();
    expect(
      await draft.evaluate((node) => node === document.activeElement),
    ).toBe(true);
    await setup.getByRole('button', { name: /Session mode: Build/ }).tap();
    const modePicker = page.getByRole('dialog', { name: 'Session mode' });
    await modePicker.getByRole('radio', { name: 'Plan', exact: true }).tap();
    await modePicker.waitFor({ state: 'hidden' });
    await setup.getByRole('button', { name: /Session mode: Plan/ }).waitFor();
    expect(
      await draft.evaluate((node) => node === document.activeElement),
    ).toBe(true);

    await setup.getByRole('button', { name: /^Engine & model:/ }).tap();
    const picker = page.getByRole('dialog', { name: 'Model', exact: true });
    await picker.getByRole('button', { name: 'GPT-5.6', exact: true }).tap();
    await picker.waitFor({ state: 'hidden' });
    expect(await page.getByLabel('Model selection focus').textContent()).toBe(
      'draft focused',
    );

    await page.keyboard.press('Escape');
    await setup.waitFor({ state: 'hidden' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await setup.waitFor();
    expect(await setup.getAttribute('aria-modal')).toBe('true');
    expect(
      await setup.evaluate((node) => node === document.activeElement),
    ).toBe(true);
    await page.keyboard.press('Tab');
    const close = setup.getByRole('button', { name: 'Close settings' });
    expect(
      await close.evaluate((node) => node === document.activeElement),
    ).toBe(true);
    await page.keyboard.press('Shift+Tab');
    expect(
      await setup.evaluate((node) => node.contains(document.activeElement)),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await setup.waitFor({ state: 'hidden' });
    await expect
      .poll(() => trigger.evaluate((node) => node === document.activeElement))
      .toBe(true);
  } finally {
    await browser.close();
  }
});
