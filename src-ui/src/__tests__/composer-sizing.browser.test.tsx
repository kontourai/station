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
      useAgentSchedule: `export const useAgentSchedule=()=>({schedule:{wakeUps:[{id:'wake',dueAt:'2026-11-15T23:00:00Z',state:'pending',note:'Check results'}],jobProposals:[],automationProposals:[]},loaded:true,cancelWakeUp:{mutate(){}},approveWakeUp:{},declineWakeUp:{},declineProposal:{},approveProposal:{},confirmAutomationProposal:{},declineAutomationProposal:{}});`,
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
      'SessionModelPicker',
      'PortableDraftsMenu',
      'AcpSessionModeChip',
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
      const textareaRef=useRef(null);
      const noop=()=>{};
      return <div className="chat-dock__body" style={{height:600,display:'flex',flexDirection:'column'}}>
        <div id="transcript" className="chat-messages" style={{flex:'1 1 0',minHeight:0,overflow:'auto',overflowAnchor:'none'}}><div style={{height:3000}}>Transcript</div></div>
        <ChatInputArea activity={<><AgentScheduleNotes conversationId="fixture" refreshKey="settled"/><ScrollToBottomButton onClick={noop}/></>} agentSlug="station" sessionId="fixture" input={input} textareaRef={textareaRef} attachments={[]} disabled={false} turnInFlight={false} modelSupportsAttachments={false} fontSize={14} dockHeight={600} apiBase="http://station.test" canModelSelect={false} availableModels={[]} modelQuery={null} commandQuery={null} slashCommands={[]} onInputChange={setInput} onSend={noop} onCancel={noop} onClearInput={noop} selectAttachmentFiles={noop} onRemoveAttachment={noop} onClearAttachments={noop} onModelSelect={noop} onModelReset={noop} onModelClose={noop} onModelOpen={noop} onModelRuntimeOptionChange={noop} onApprovalModeChange={noop} onCommandSelect={noop} onCommandClose={noop} onHistoryUp={noop} onHistoryDown={noop} onShowStats={noop} updateFromInput={noop} closeAll={noop}/>
      </div>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `;

test('sizes draft content without transiently clamping the pinned transcript', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(
    composerFixture,
    [controls],
  );
  try {
    await page.addStyleTag({ content: cascade });
    await page.waitForSelector('textarea');
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
});

test('scheduled check-backs share the composer activity row with Scroll to bottom in both themes and widths', async () => {
  const artifacts = resolve('.surface/inbox-chat-polish');
  await mkdir(artifacts, { recursive: true });
  for (const width of [390, 1440])
    for (const theme of ['dark', 'light']) {
      const { browser, page, errors } = await scrollBrowserFixture(
        composerFixture,
        [controls],
        { viewport: { width, height: 900 } },
      );
      try {
        await page.addStyleTag({ content: cascade });
        await page.evaluate(
          (value) => (document.documentElement.dataset.theme = value),
          theme,
        );
        const note = page.getByText(/Checking back at/);
        await note.waitFor();
        const noteBox = (await note.boundingBox())!;
        const scroll = (await page
          .getByRole('button', { name: 'Scroll to bottom' })
          .boundingBox())!;
        expect(scroll.y).toBeLessThan(noteBox.y + noteBox.height);
        expect(scroll.y + scroll.height).toBeGreaterThan(noteBox.y);
        expect(scroll.x).toBeGreaterThan(noteBox.x + noteBox.width);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
        ).toBe(false);
        expect(errors).toEqual([]);
        await page.screenshot({
          path: resolve(artifacts, `scheduled-${width}-${theme}.png`),
          animations: 'disabled',
        });
      } finally {
        await browser.close();
      }
    }
});
