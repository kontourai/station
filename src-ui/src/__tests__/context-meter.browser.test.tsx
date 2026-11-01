import { resolve } from 'node:path';
import type { Plugin } from 'esbuild';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

/**
 * The context meter in the composer's controls row, laid out by the real
 * stylesheets and design tokens in Chromium. Its track once sat in a
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

test('the composer’s context meter has a visible track and fill in the controls row', async () => {
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
    // Design tokens: the ring's track stroke is a token, unset without them.
    await page.addStyleTag({
      content: resolveCssImports(resolve('src-ui/src/index.css')),
    });
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
      const stroke = (selector: string) => {
        const style = getComputedStyle(document.querySelector(selector)!);
        return {
          color: style.stroke,
          width: style.strokeWidth,
          dash: style.strokeDasharray,
        };
      };
      return {
        track: box('.context-meter__track'),
        ring: box('.context-meter__ring'),
        trackStroke: stroke('.context-meter__track'),
        fillStroke: stroke('.context-meter__fill'),
        model: box('.chat-input__model-btn'),
        meterInControls: Boolean(
          document
            .querySelector('.context-meter')
            ?.closest('.chat-controls-row'),
        ),
      };
    });
    // #4377: the meter trails the controls row, right of the model picker.
    expect(geometry.meterInControls).toBe(true);
    expect(geometry.track.left).toBeGreaterThan(geometry.model.left);
    // #4377: a ring. The track is a stroked circle with real size; the
    // fill's dash covers 4 of the circle's 100 path units.
    expect(geometry.ring.width).toBeGreaterThanOrEqual(20);
    expect(geometry.trackStroke.color).not.toBe('none');
    expect(parseFloat(geometry.trackStroke.width)).toBeGreaterThan(0);
    expect(parseFloat(geometry.fillStroke.width)).toBeGreaterThan(0);
    expect(geometry.fillStroke.dash.replace(/px/g, '')).toMatch(/^4,? 100$/);
    expect(await meter.textContent()).toBe('4%');
  } finally {
    await browser.close();
  }
});
