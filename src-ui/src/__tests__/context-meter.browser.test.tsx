import type { Plugin } from 'esbuild';
import { expect, test } from 'vitest';
import { scrollBrowserFixture } from './scroll-browser-fixture';

/**
 * The context meter in the composer's meta row, beside the model picker, laid
 * out by the real stylesheets in Chromium. Its track once sat in a
 * shrink-to-fit button as a `flex: 1` box and resolved to 0px, so the meter
 * read "Context:  (4.0%)" with no bar at all; jsdom cannot see that.
 */

// Composer controls that are not under test, and the stats read the meter
// would otherwise make, are stubbed by module name (the composer-sizing
// fixture's idiom). `ContextPercentage` itself is real.
const controls: Plugin = {
  name: 'composer-controls',
  setup(builder) {
    const modules: Record<string, string> = {
      DeviceSettingsContext:
        'export const useDeviceSettings = () => ({chatReturnBehavior:"newline"});',
      KeyboardShortcutsContext: 'export const setShortcutContext = () => {};',
      UnconfirmedDiscardConfirm:
        'export const UnconfirmedDiscardConfirm=()=>null; export const useUnconfirmedDiscardDisclosure=()=>({});',
      StatsContext:
        'export const useStats = () => ({ stats: { contextWindowPercentage: 4 }, refetch: () => {} });',
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

test('the composer’s context meter has a visible track and fill beside the model picker', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(
    `
    import React, {useRef,useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {ChatInputArea} from './src-ui/src/components/chat/ChatInputArea';
    import {ContextPercentage} from './src-ui/src/components/conversation-stats/ContextPercentage';
    function App(){
      const [input,setInput] = useState('');
      const textareaRef=useRef(null);
      const noop=()=>{};
      const meter = <ContextPercentage agentSlug="station" conversationId="c-1" apiBase="http://station.test" onClick={noop}/>;
      return <div className="chat-dock__body" style={{height:600,display:'flex',flexDirection:'column'}}>
        <div style={{flex:'1 1 0'}}/>
        <ChatInputArea contextMeter={meter} agentSlug="station" sessionId="fixture" input={input} textareaRef={textareaRef} attachments={[]} disabled={false} turnInFlight={false} modelSupportsAttachments={false} fontSize={14} dockHeight={600} apiBase="http://station.test" canModelSelect={false} availableModels={[]} modelQuery={null} commandQuery={null} slashCommands={[]} onInputChange={setInput} onSend={noop} onCancel={noop} onClearInput={noop} selectAttachmentFiles={noop} onRemoveAttachment={noop} onClearAttachments={noop} onModelSelect={noop} onModelReset={noop} onModelClose={noop} onModelOpen={noop} onModelRuntimeOptionChange={noop} onApprovalModeChange={noop} onCommandSelect={noop} onCommandClose={noop} onHistoryUp={noop} onHistoryDown={noop} onShowStats={noop} updateFromInput={noop} closeAll={noop}/>
      </div>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `,
    [controls],
  );
  try {
    const meter = page.getByRole('button', { name: 'Context 4.0% used' });
    await meter.waitFor();
    expect(errors).toEqual([]);
    const geometry = await page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`missing ${selector}`);
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, width: rect.width };
      };
      return {
        track: box('.context-meter__track'),
        fill: box('.context-meter__fill'),
        model: box('.chat-input__model-btn'),
        meterInMeta: Boolean(
          document
            .querySelector('.context-meter')
            ?.closest('.chat-input__meta .chat-input__settings'),
        ),
      };
    });
    // In the composer's meta row, after the model picker it measures.
    expect(geometry.meterInMeta).toBe(true);
    expect(geometry.track.left).toBeGreaterThan(geometry.model.left);
    // The track has its own width; the fill is 4% of it, not of nothing.
    expect(geometry.track.width).toBeGreaterThanOrEqual(20);
    expect(geometry.fill.width).toBeGreaterThan(0);
    expect(geometry.fill.width).toBeCloseTo(geometry.track.width * 0.04, 0);
    expect(await meter.textContent()).toBe('4%');
  } finally {
    await browser.close();
  }
});
