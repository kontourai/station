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

/** A phone composer whose Agent (no mark) now points at another engine. */
function composer(
  nextTurn: boolean,
  {
    model = 'claude-sonnet-4-5-20250929',
    to = 'OpenCode Zen gateway (work)',
  } = {},
) {
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
          agentEngineMove={{to:'${to}', nextTurn:${nextTurn}}}
          currentModel="${model}"
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

test('a phone composer shows the next-turn destination in full above its Run setup trigger', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(composer(true), [
    controls,
  ]);
  try {
    await page.waitForSelector('textarea');
    expect(errors).toEqual([]);
    // The row carries the Run setup trigger, whose closed panel keeps the
    // four real controls mounted (the Mode one loads lazily).
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '.chat-input__settings > .composer-run-control',
        ).length === 1 &&
        document.querySelectorAll('.composer-run-panel__choices > *').length >=
          4,
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

/** Mount `composer`, with the app's design tokens, until Run setup is ready. */
async function mounted(source: string) {
  const fixture = await scrollBrowserFixture(source, [controls]);
  // Design tokens: the row and the Run setup sheet at their real widths.
  await fixture.page.addStyleTag({
    content: resolveCssImports(resolve('src-ui/src/index.css')),
  });
  await fixture.page.waitForSelector('textarea');
  await fixture.page.waitForFunction(
    () =>
      document.querySelectorAll('.chat-input__settings > .composer-run-control')
        .length === 1 &&
      document.querySelectorAll('.composer-run-panel__choices > *').length >= 4,
  );
  return fixture;
}

/** The closed trigger's label, Agent name and hint as painted. */
function closedTrigger() {
  const trigger = document.querySelector('.composer-run-control')!;
  const label = trigger.querySelector('.chat-input__chip-stack')!;
  const box = label.getBoundingClientRect();
  const agent = trigger.querySelector('.composer-run-control__agent');
  const agentBox = agent?.getBoundingClientRect();
  const notice = trigger.querySelector('.composer-run-control__notice')!;
  // What a person reads: each of the hint's parts that has a painted box.
  let painted = '';
  for (const node of notice.childNodes)
    if (
      node.nodeType === Node.TEXT_NODE ||
      (node as Element).getBoundingClientRect().width > 0
    )
      painted += node.textContent;
  return {
    labelWidth: box.width,
    agent:
      agentBox &&
      agentBox.width > 0 &&
      agentBox.top < box.bottom &&
      agentBox.bottom > box.top &&
      agentBox.left < box.right
        ? { width: agentBox.width }
        : null,
    painted,
  };
}

test('a phone composer\'s Run setup trigger keeps "Agent moved" whole while its label gives way', async () => {
  const { browser, page, errors } = await mounted(
    // A model id too long for the row, so the label has to give way.
    composer(false, {
      model: 'opencode-zen-gateway-reasoning-model-preview-2026-11',
    }),
  );
  try {
    expect(errors).toEqual([]);
    expect(await page.locator('.chat-input__next-turn-notice').count()).toBe(0);
    // With Run setup closed, its trigger says the Agent moved, at every phone
    // width: where the label collapses to marks (320, 360) and where it shows.
    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const hint = await page.evaluate(
        unclipped,
        '.composer-run-control__notice',
      );
      expect(hint, `${width}px`).toMatchObject({
        found: true,
        text: '· Agent moved',
      });
      expect(hint.display, `${width}px`).not.toBe('none');
      expect(hint.width, `${width}px`).toBeGreaterThan(0);
      expect(hint.ownOverflow, `${width}px`).toBeLessThanOrEqual(0);
      expect(hint, `${width}px`).toMatchObject({
        inViewport: true,
        clippedBy: null,
      });
      const row = await page.evaluate(closedTrigger);
      if (width < 390) {
        // The label has collapsed, so the hint follows the marks alone and
        // does not open with a separator.
        expect(row.labelWidth, `${width}px`).toBe(0);
        expect(row.painted, `${width}px`).toBe('Agent moved');
      } else {
        expect(row.labelWidth, `${width}px`).toBeGreaterThan(0);
        expect(row.painted, `${width}px`).toBe('· Agent moved');
        // The label is what gave way: the model reads ahead of an ellipsis.
        const model = await page.evaluate(
          unclipped,
          '.composer-run-control__model',
        );
        expect(model.width).toBeGreaterThan(48);
        expect(model.ownOverflow).toBeGreaterThan(0);
      }
      // An Agent with no mark shows its name only where it can be read:
      // never a one-letter stub.
      if (row.agent)
        expect(row.agent.width, `${width}px`).toBeGreaterThanOrEqual(40);
    }
    // A wide composer keeps the Agent name beside the hint.
    await page.setViewportSize({ width: 1280, height: 844 });
    const wide = await page.evaluate(closedTrigger);
    expect(wide.painted).toBe('· Agent moved');
    expect(wide.agent?.width).toBeGreaterThanOrEqual(80);
    await page.setViewportSize({ width: 390, height: 844 });

    // Not by position alone: the trigger's name and description say it too.
    const trigger = page.getByRole('button', { name: /; Agent moved$/ });
    expect(await trigger.count()).toBe(1);
    expect(
      await trigger.evaluate(
        (button) =>
          document.getElementById(button.getAttribute('aria-describedby')!)
            ?.textContent,
      ),
    ).toBe(
      'This conversation runs on Claude Code (work). Its Agent now uses OpenCode Zen gateway (work).',
    );

    // Opened, the sheet holds the four real controls and names where the
    // Agent moved, with nothing wider than the sheet and nothing clipped.
    await trigger.click();
    const sheet = page.getByRole('dialog', { name: 'Run setup' });
    await sheet.waitFor();
    for (const name of [
      /^Agent: /,
      /^Engine & model: /,
      /^Session mode: /,
      /^Approval: /,
    ])
      expect(await sheet.getByRole('button', { name }).isVisible()).toBe(true);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const move = await page.evaluate(
        unclipped,
        '.composer-run-panel .chat-input__engine-moved',
      );
      expect(move, `${width}px`).toMatchObject({
        found: true,
        text: 'Agent now on OpenCode Zen gateway (work)',
        inViewport: true,
        clippedBy: null,
      });
      expect(move.ownOverflow, `${width}px`).toBeLessThanOrEqual(0);
      expect(await page.evaluate(moveLine), `${width}px`).toEqual({
        below: true,
        separator: false,
      });
      expect(await page.evaluate(sheetFaults), `${width}px`).toEqual([]);
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('the Run setup sheet puts even a short move on its own line', async () => {
  // "Agent now on Codex" would fit beside the engine name.
  const { browser, page, errors } = await mounted(
    composer(false, { to: 'Codex' }),
  );
  try {
    await page.getByTestId('run-setup-trigger').click();
    await page.getByRole('dialog', { name: 'Run setup' }).waitFor();
    expect(
      await page
        .locator('.composer-run-panel .chat-input__engine-moved')
        .innerText(),
    ).toMatch(/^Agent now on Codex$/i);
    expect(await page.evaluate(moveLine)).toEqual({
      below: true,
      separator: false,
    });
    expect(await page.evaluate(sheetFaults)).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

/** Whether the sheet's move line sits below the engine name, and whether its
 * painted text (a generated `::before` included) opens with a separator. */
function moveLine() {
  const caption = document.querySelector(
    '.composer-run-panel .chat-input__chip-caption:has(.chat-input__engine-moved)',
  )!;
  const engine = caption.querySelector('.chat-input__chip-caption-engine')!;
  const moved = caption.querySelector('.chat-input__engine-moved')!;
  // `content` reads back quoted.
  const before = getComputedStyle(moved, '::before').content;
  const generated =
    before === 'none' || before === 'normal'
      ? ''
      : before.replace(/^"(.*)"$/, '$1');
  const text = (generated + (moved as HTMLElement).innerText).trimStart();
  return {
    below:
      moved.getBoundingClientRect().top >=
      engine.getBoundingClientRect().bottom - 0.5,
    separator: /^[·•|-]/.test(text),
  };
}

/** Anything in the sheet painted outside it, and any choice whose text
 * reaches into its border. */
function sheetFaults() {
  const panel = document.querySelector('.composer-run-panel')!;
  const box = panel.getBoundingClientRect();
  const faults: string[] = [];
  if (box.left < 0 || box.right > window.innerWidth) faults.push('sheet');
  for (const element of panel.querySelectorAll('*')) {
    const rect = element.getBoundingClientRect();
    if (
      rect.width > 0 &&
      (rect.left < box.left - 0.5 || rect.right > box.right + 0.5)
    )
      faults.push(`wider: ${element.className}`);
  }
  for (const choice of panel.querySelectorAll('.composer-choice')) {
    const outer = choice.getBoundingClientRect();
    const top = outer.top + choice.clientTop;
    const bottom = top + choice.clientHeight;
    const text = choice
      .querySelector('.chat-input__chip-stack')!
      .getBoundingClientRect();
    if (text.top < top + 1 || text.bottom > bottom - 1)
      faults.push(`clipped: ${choice.className}`);
  }
  return faults;
}
