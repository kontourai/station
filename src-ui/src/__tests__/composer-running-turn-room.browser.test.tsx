import { resolve } from 'node:path';
import type { Plugin } from 'esbuild';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// Controls that need an API provider are stubbed; the four chips on the row
// (Agent, Engine & model, Mode, Approval) are the real components.
const controls: Plugin = {
  name: 'composer-controls',
  setup(builder) {
    const modules: Record<string, string> = {
      DeviceSettingsContext:
        'export const useDeviceSettings = () => ({chatReturnBehavior:"newline"});',
      KeyboardShortcutsContext: 'export const setShortcutContext = () => {};',
      UnconfirmedDiscardConfirm:
        'export const UnconfirmedDiscardConfirm=()=>null; export const useUnconfirmedDiscardDisclosure=()=>({});',
    };
    const names = [
      'ComposerActionsMenu',
      'VoiceOrb',
      'ComposerIconAction',
      'ComposerStopButton',
      'SessionModelPicker',
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

/** A phone composer during a running turn, with or without a draft. */
function runningTurn(input: string, width = 390) {
  return `
    import React, {useRef} from 'react';
    import {createRoot} from 'react-dom/client';
    import {ChatInputArea} from './src-ui/src/components/chat/ChatInputArea';
    function App(){
      const textareaRef=useRef(null);
      const noop=()=>{};
      return <div className="chat-dock__body" style={{height:700,width:${width},display:'flex',flexDirection:'column',justifyContent:'flex-end'}}>
        <ChatInputArea agentSlug="claude" sessionId="fixture" input=${JSON.stringify(input)} textareaRef={textareaRef} attachments={[]} disabled={false} turnInFlight={true} busyFollowUp="steer" onQueueFollowUp={noop} modelSupportsAttachments={true} fontSize={14} dockHeight={700} apiBase="http://station.test" canModelSelect={true}
          availableModels={[{id:'claude-opus-4-5',name:'Claude Opus 4.5 with extended context'}]} agentDefaultModel="claude-opus-4-5" modelQuery={null} commandQuery={null} slashCommands={[]}
          agentLabel="Claude Code" agentIcon={<svg width="24" height="24"/>}
          onInputChange={noop} onSend={noop} onCancel={noop} onClearInput={noop} selectAttachmentFiles={noop} onRemoveAttachment={noop} onClearAttachments={noop} onModelSelect={noop} onModelReset={noop} onModelClose={noop} onModelOpen={noop} onModelRuntimeOptionChange={noop} onApprovalModeChange={noop} onCommandSelect={noop} onCommandClose={noop} onHistoryUp={noop} onHistoryDown={noop} onShowStats={noop} updateFromInput={noop} closeAll={noop}/>
      </div>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `;
}

async function runningTurnGeometry(input: string, width = 390) {
  const { browser, page, errors } = await scrollBrowserFixture(
    runningTurn(input, width),
    [controls],
  );
  try {
    await page.waitForSelector('[data-testid="run-setup-trigger"]');
    expect(errors).toEqual([]);
    // The real cascade: the composer's container and tokens live in index.css.
    await page.addStyleTag({
      content: resolveCssImports(resolve(import.meta.dirname, '../index.css')),
    });
    return await page.evaluate(() => {
      const submit = document.querySelector('.chat-input__submit-controls')!;
      const trigger = document.querySelector(
        '[data-testid="run-setup-trigger"]',
      )!;
      return {
        submitWidth: submit.getBoundingClientRect().width,
        submitDisplay: getComputedStyle(submit).display,
        triggerWidth: trigger.getBoundingClientRect().width,
      };
    });
  } finally {
    await browser.close();
  }
}

test('an empty phone draft during a turn gives Send/Steer room to Run setup', async () => {
  const empty = await runningTurnGeometry('');
  const typed = await runningTurnGeometry('a follow-up');
  // Nothing to send or steer yet: the hidden group takes no room at all.
  expect(empty.submitDisplay).toBe('none');
  expect(empty.submitWidth).toBe(0);
  // With a draft, Send and Steer appear and take their room back.
  expect(typed.submitWidth).toBeGreaterThanOrEqual(44);
  expect(empty.triggerWidth).toBeGreaterThan(typed.triggerWidth);
});
