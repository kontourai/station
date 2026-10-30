import type { Plugin } from 'esbuild';
import { expect, test } from 'vitest';
import { scrollBrowserFixture } from './scroll-browser-fixture';

const refusal: Plugin = {
  name: 'refused-visual-read',
  setup(builder) {
    const modules: Record<string, string> = {
      '@tanstack/react-query':
        'export const useQuery=()=>({error:new Error("refused")});',
      ApiBaseContext:
        'export const useHostRequestAuthorityScope=()=>undefined;',
      DeviceSettingsContext:
        'export const useDeviceSettings=()=>({theme:"dark"});',
      PreviewContext: 'export const useOptionalPreview=()=>undefined;',
      MarkdownLinkContext: 'export const useMarkdownLinkContext=()=>undefined;',
    };
    builder.onResolve({ filter: /./ }, ({ path, importer }) => {
      if (
        path === '@tanstack/react-query' &&
        !importer.endsWith('WorkspaceFileReply.tsx')
      )
        return undefined;
      const key = modules[path] ? path : path.split('/').at(-1)!;
      return modules[key] ? { path: key, namespace: 'refusal' } : undefined;
    });
    builder.onLoad({ filter: /.*/, namespace: 'refusal' }, ({ path }) => ({
      contents: modules[path],
      loader: 'js',
    }));
  },
};

test('a refused workspace link remains in its surrounding sentence', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(
    `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {WorkspaceFileReply} from './src-ui/src/components/chat/WorkspaceFileReply';
    import './src-ui/src/components/chat/HtmlReply.css';
    createRoot(document.getElementById('root')).render(<p><span id="before">See </span><WorkspaceFileReply path="missing.html">the file</WorkspaceFileReply><span id="after"> for details.</span></p>);
  `,
    [refusal],
  );
  try {
    await page.setViewportSize({ width: 1440, height: 844 });
    await page.locator('.workspace-file-reply--unavailable').waitFor();
    const geometry = await page.evaluate(() => {
      const before = document.querySelector('#before')!.getBoundingClientRect();
      const link = document.querySelector(
        '.workspace-file-reply--unavailable',
      )!;
      const after = document.querySelector('#after')!.getBoundingClientRect();
      return {
        display: getComputedStyle(link).display,
        before: before.top,
        link: link.getBoundingClientRect().top,
        after: after.top,
      };
    });
    expect(errors).toEqual([]);
    expect(geometry.display).toBe('inline');
    expect(geometry.link).toBe(geometry.before);
    expect(geometry.after).toBe(geometry.before);
  } finally {
    await browser.close();
  }
});
