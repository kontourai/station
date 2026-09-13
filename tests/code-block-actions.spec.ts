/** Real rendered-height boundary; clipboard permission/results are explicit input fixtures. */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { build } from 'esbuild';
import { test } from './helpers/fixture-audit';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let script = '';
let stylesheet = '';
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: ROOT,
      loader: 'tsx',
      contents: `
      import { useState } from 'react'; import { createRoot } from 'react-dom/client';
      import { CodeBlockFrame } from './src-ui/src/components/chat/CodeBlockFrame';
      const short = 'const value = 42;'; const long = Array.from({length:50},(_,i)=>'line '+i+' value = 42;').join('\\n');
      window.copiedText = ''; window.denyCopy = false;
      Object.defineProperty(navigator, 'clipboard', {value:{writeText:async(text)=>{if(window.denyCopy)throw new Error('denied');window.copiedText=text;}}});
      document.execCommand = () => false;
      function Harness() {
        const [large,setLarge]=useState(false); const [highlighted,setHighlighted]=useState(false);
        const code=large?long:short;
        return <main style={{padding:16}}><button onClick={()=>setLarge(!large)}>Change length</button><button onClick={()=>setHighlighted(!highlighted)}>Change renderer</button><button onClick={()=>{window.denyCopy=true;}}>Refuse clipboard</button>
          <div className="chat-messages" style={{height:300,overflow:'auto',display:'block'}}><CodeBlockFrame lang="text" code={code} html={highlighted?'<pre><code>'+code+'</code></pre>':null}/></div>
          <output aria-label="Copied text">{window.copiedText}</output>
        </main>;
      }
      createRoot(document.getElementById('root')).render(<Harness/>);
    `,
    },
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    platform: 'browser',
    write: false,
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  script = result.outputFiles[0].text;
  const styles = await build({
    stdin: {
      contents:
        '@import "./src-ui/src/index.css"; @import "./src-ui/src/components/chat/CodeBlockFrame.css";',
      resolveDir: ROOT,
      loader: 'css',
    },
    bundle: true,
    write: false,
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.png': 'dataurl' },
    plugins: [
      {
        name: 'public-assets',
        setup(builder) {
          builder.onResolve({ filter: /^\/(fonts\/|favicon)/ }, (args) => ({
            path: join(ROOT, 'src-ui/public', args.path.slice(1)),
          }));
        },
      },
    ],
  });
  stylesheet = styles.outputFiles[0].text;
});

for (const theme of ['light', 'dark']) {
  test(`a long ${theme} block repeats copy below the complete source and removes the footer when short`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.setContent(
      '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>',
    );
    await page.addStyleTag({ content: stylesheet });
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.addScriptTag({ content: script });
    await page.evaluate(() => document.fonts.ready);
    await expect(
      page.getByRole('button', { name: 'Copy', exact: true }),
    ).toHaveCount(1);
    await page.getByRole('button', { name: 'Change length' }).click();
    await expect(
      page.getByRole('button', { name: 'Copy', exact: true }),
    ).toHaveCount(2);
    const footer = page
      .getByRole('button', { name: 'Copy', exact: true })
      .last();
    await footer.click();
    expect(await page.evaluate(() => Reflect.get(window, 'copiedText'))).toBe(
      Array.from({ length: 50 }, (_, i) => 'line ' + i + ' value = 42;').join(
        '\n',
      ),
    );
    await expect(
      page.getByRole('button', { name: 'Copied', exact: true }),
    ).toHaveCount(2);
    const box = (await page
      .getByRole('button', { name: 'Copied', exact: true })
      .last()
      .boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await page.getByRole('button', { name: 'Change renderer' }).click();
    await page.getByRole('button', { name: 'Refuse clipboard' }).click();
    await page
      .locator('.code-block-actions')
      .last()
      .getByRole('button')
      .click();
    await expect(
      page.getByRole('button', { name: "Can't copy", exact: true }),
    ).toHaveCount(2);
    await page.screenshot({
      path: testInfo.outputPath(`code-copy-${theme}.png`),
    });
    await page.getByRole('button', { name: 'Change length' }).click();
    await expect(page.locator('.code-block-actions')).toHaveCount(1);
  });
}
