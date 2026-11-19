import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

const fixture = `
  import {createRoot} from 'react-dom/client';
  import {StartComposer} from './src-ui/src/components/chat-start/StartComposer';
  const noop = () => {};
  createRoot(document.getElementById('root')).render(
    <StartComposer
      prompt="Tell me about this project"
      onPromptChange={noop}
      agent={{status: 'ready', needsSetup: false, label: 'OpenCode', modelLabel: 'zai-coding-plan/glm-5.3-flash'}}
      project={{status: 'ready', label: 'No project', isGlobal: true}}
      onOpenAgents={noop}
      onOpenModel={noop}
      onOpenProject={noop}
      canStart
      pending={false}
      onStart={noop}
      files={{list: [], onAdd: noop, onRemove: noop}}
      voice={{state: 'idle', supported: true, onStart: noop, onStop: noop}}
      overflowActions={[{key: 'example', label: 'More settings', onSelect: noop}]}
    />
  );
`;

test('Start stays at the trailing edge when the shared toolbar wraps', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(fixture);
  try {
    await page.addStyleTag({
      content: resolveCssImports(resolve('src-ui/src/index.css')),
    });
    const start = page.getByRole('button', { name: 'Start', exact: true });
    const tools = page.locator('.start-composer__tools');
    const toolbar = page.locator('.start-composer__actions');
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      const buttonBox = (await start.boundingBox())!;
      const toolsBox = (await tools.boundingBox())!;
      const toolbarBox = (await toolbar.boundingBox())!;
      expect(buttonBox.y > toolsBox.y + toolsBox.height).toBe(width < 1440);
      expect(buttonBox.x + buttonBox.width).toBeCloseTo(
        toolbarBox.x + toolbarBox.width,
      );
      expect(buttonBox.height).toBeGreaterThanOrEqual(44);
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
