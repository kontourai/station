import type { Plugin } from 'esbuild';
import { expect, test } from 'vitest';
import { scrollBrowserFixture } from './scroll-browser-fixture';

const preview: Plugin = {
  name: 'file-preview-read',
  setup(builder) {
    const modules: Record<string, string> = {
      'workspace-file-preview': `export const useProjectWorkspaceFilePreviewQuery=()=>({isLoading:false,isError:false,data:{path:'notes.txt',status:'ready',renderKind:'text',content:Array.from({length:200},(_,i)=>'Line '+(i+1)).join('\\n')}});
        export const useProjectWorkspaceFileChangesQuery=()=>({data:{state:'unchanged',base:'HEAD'}});
        export const isRepositoryBusyError=()=>false;export const isWorkspaceFilePreviewImageDataUrl=()=>false;export const WORKSPACE_FILE_PREVIEW_MAX_BYTES=524288;export const downloadProjectWorkspaceFilePreview=()=>{};`,
      NavigationContext:
        'export const useNavigation=()=>({navigate(){},selectedProjectLayout:"coding"});',
      CodingFilesContextProvider:
        'export const useCodingFilesContext=()=>({addFile(){},has(){return false},removeFile(){}});',
      resolvedWorkspacePaneCatalog:
        'export const useResolvedWorkspacePaneCatalog=()=>({entries:[]});',
      'highlight-client': 'export const tokenizeCode=()=>new Promise(()=>{});',
      FilePreviewChanges: 'export const FilePreviewChanges=()=>null;',
    };
    builder.onResolve({ filter: /./ }, (args) => {
      const key = args.path.split('/').at(-1)!;
      // The contract parser stays real; only the SDK read is supplied here.
      return key in modules &&
        !args.path.startsWith('@kontourai/station-contracts')
        ? { path: key, namespace: 'preview' }
        : undefined;
    });
    builder.onLoad({ filter: /.*/, namespace: 'preview' }, (args) => ({
      contents: modules[args.path],
      loader: 'tsx',
      resolveDir: process.cwd(),
    }));
  },
};

test('a file line reveal is centered before paint inside the preview without scrolling its ancestors', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(
    `
    import React, {useState,useLayoutEffect} from 'react';
    import {createRoot} from 'react-dom/client';
    import {FilePreviewPane} from './src-ui/src/workspace-panes/FilePreviewPane';
    function App(){
      const [open,setOpen]=useState(false);
      useLayoutEffect(()=>{if(open){const surface=document.querySelector('[data-station-performance-surface="workspace-file-preview"]');window.firstTop=surface.scrollTop;}},[open]);
      return <><button onClick={()=>setOpen(true)}>Open line</button><div id="outer" style={{height:300,overflow:'auto'}}><div style={{paddingTop:180,paddingBottom:500}}>{open&&<div style={{height:260,display:'flex',flexDirection:'column'}}><FilePreviewPane projectSlug="demo" stateKey="file-reveal" state={{version:'1.0',projectSlug:'demo',path:'notes.txt',lineRange:{start:150,end:150},wrap:true}}/></div>}</div></div></>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `,
    [preview],
  );
  try {
    await page.getByRole('button', { name: 'Open line', exact: true }).click();
    expect(errors).toEqual([]);
    const geometry = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>(
        '[data-station-performance-surface="workspace-file-preview"]',
      )!;
      const row = document.querySelector<HTMLElement>('[data-line="150"]')!;
      return {
        outer: document.querySelector('#outer')!.scrollTop,
        top: surface.scrollTop,
        center:
          row.getBoundingClientRect().top +
          row.getBoundingClientRect().height / 2 -
          surface.getBoundingClientRect().top -
          surface.clientHeight / 2,
      };
    });
    expect(geometry.outer).toBe(0);
    expect(Math.abs(geometry.center)).toBeLessThanOrEqual(2);
    expect(await page.evaluate('window.firstTop')).toBeGreaterThan(0);
    expect(geometry.top).toBeGreaterThan(0);
  } finally {
    await browser.close();
  }
});
