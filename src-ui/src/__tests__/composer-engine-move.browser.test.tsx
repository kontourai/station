import type { Plugin } from 'esbuild';
import { expect, test } from 'vitest';
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

/** A phone composer with four chips and long engine names. */
function composer(nextTurn: boolean) {
  return `
    import React, {useRef} from 'react';
    import {createRoot} from 'react-dom/client';
    import {ChatInputArea} from './src-ui/src/components/chat/ChatInputArea';
    function App(){
      const textareaRef=useRef(null);
      const noop=()=>{};
      return <div className="chat-dock__body" style={{height:700,display:'flex',flexDirection:'column',justifyContent:'flex-end'}}>
        <ChatInputArea agentSlug="reviewer" sessionId="fixture" input="" textareaRef={textareaRef} attachments={[]} disabled={false} turnInFlight={false} modelSupportsAttachments={false} fontSize={14} dockHeight={700} apiBase="http://station.test" canModelSelect={true} availableModels={[]} modelQuery={null} commandQuery={null} slashCommands={[]}
          agentLabel="Release reviewer (work)" onOpenAgentHandoff={noop}
          executionEngineLabel="Claude Code (work)"
          agentEngineMove={{to:'OpenCode Zen gateway (work)', nextTurn:${nextTurn}}}
          currentModel="claude-sonnet-4-5-20250929"
          executionMode="external"
          acpSessionModes={[{id:'build',name:'build'},{id:'plan',name:'plan'}]} acpCurrentModeId="build" onAcpSessionModeChange={noop}
          acpApproval={{control:'engine', engineName:'OpenCode Zen gateway (work)', engineId:'opencode'}}
          onInputChange={noop} onSend={noop} onCancel={noop} onClearInput={noop} selectAttachmentFiles={noop} onRemoveAttachment={noop} onClearAttachments={noop} onModelSelect={noop} onModelReset={noop} onModelClose={noop} onModelOpen={noop} onModelRuntimeOptionChange={noop} onApprovalModeChange={noop} onCommandSelect={noop} onCommandClose={noop} onHistoryUp={noop} onHistoryDown={noop} onShowStats={noop} updateFromInput={noop} closeAll={noop}/>
      </div>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `;
}

/**
 * Whether `selector`'s text is painted in full: it has a box, its text is not
 * cut by its own overflow, and no clipping ancestor or the viewport cuts it.
 */
function unclipped(selector: string) {
  const element = document.querySelector(selector) as HTMLElement | null;
  if (!element) return { found: false };
  const rect = element.getBoundingClientRect();
  let clippedBy: string | null = null;
  for (
    let ancestor = element.parentElement;
    ancestor && !clippedBy;
    ancestor = ancestor.parentElement
  ) {
    const style = getComputedStyle(ancestor);
    if (style.overflowX === 'visible' && style.overflowY === 'visible')
      continue;
    const box = ancestor.getBoundingClientRect();
    if (
      rect.left < box.left - 0.5 ||
      rect.right > box.right + 0.5 ||
      rect.top < box.top - 0.5 ||
      rect.bottom > box.bottom + 0.5
    )
      clippedBy = ancestor.className || ancestor.tagName;
  }
  return {
    found: true,
    text: element.textContent,
    width: rect.width,
    height: rect.height,
    ownOverflow: element.scrollWidth - element.clientWidth,
    inViewport: rect.left >= 0 && rect.right <= window.innerWidth,
    clippedBy,
    display: getComputedStyle(element).display,
  };
}

test('a phone composer shows the next-turn destination in full beside four chips', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(composer(true), [
    controls,
  ]);
  try {
    await page.waitForSelector('textarea');
    expect(errors).toEqual([]);
    // The row really carries four chips (the Mode chip loads lazily).
    await page.waitForFunction(
      () => document.querySelectorAll('.chat-input__settings > *').length >= 4,
    );
    const destination = await page.evaluate(
      unclipped,
      '.chat-input__next-turn-destination',
    );
    expect(destination).toMatchObject({
      found: true,
      text: 'OpenCode Zen gateway (work)',
      inViewport: true,
      clippedBy: null,
    });
    expect(destination.width).toBeGreaterThan(0);
    expect(destination.height).toBeGreaterThan(0);
    expect(destination.ownOverflow).toBeLessThanOrEqual(0);
    expect(
      await page.locator('.chat-input__next-turn-notice').innerText(),
    ).toBe('Next turn starts on OpenCode Zen gateway (work)');
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('a phone composer keeps "Agent moved" visible ahead of a long engine name', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(
    composer(false),
    [controls],
  );
  try {
    await page.waitForSelector('textarea');
    await page.waitForFunction(
      () => document.querySelectorAll('.chat-input__settings > *').length >= 4,
    );
    expect(errors).toEqual([]);
    expect(await page.locator('.chat-input__next-turn-notice').count()).toBe(0);
    const hint = await page.evaluate(
      unclipped,
      '.chat-input__engine-moved--short',
    );
    expect(hint).toMatchObject({
      found: true,
      text: ' · Agent moved',
      inViewport: true,
      clippedBy: null,
    });
    expect(hint.width).toBeGreaterThan(0);
    // The engine name is what gave way.
    const engine = await page.evaluate(
      unclipped,
      '.chat-input__chip-caption-engine',
    );
    expect(engine.ownOverflow).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
