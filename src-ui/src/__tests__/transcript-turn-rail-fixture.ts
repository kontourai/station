import { dirname, resolve } from 'node:path';
import type { Plugin } from 'esbuild';
import {
  assertNoImportsSurvive,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

const ROOT = resolve(import.meta.dirname, '../../..');

/**
 * Replaces the providers ChatMessageList reads from the app shell with fixed
 * values, keeping every other export of those modules. Stylesheets imported
 * by components are dropped from the bundle; the page gets the real
 * cascade-resolved app CSS instead.
 */
const STUBS: Array<{ pattern: RegExp; overrides: string }> = [
  {
    pattern: /src-ui\/src\/contexts\/AgentsContext\.tsx?$/,
    overrides: 'export const useAgents = () => [];',
  },
  {
    pattern: /src-ui\/src\/contexts\/ApiBaseContext\.tsx?$/,
    overrides:
      "export const useApiBase = () => ({ apiBase: 'http://station.test' });\nexport const useHostRequestAuthorityScope = () => null;",
  },
  {
    pattern: /src-ui\/src\/contexts\/AuthContext\.tsx?$/,
    overrides:
      "export const useAuth = () => ({ status: 'valid', user: null, provider: null, expiresAt: null, renew: async () => {}, isRenewing: false });",
  },
  {
    pattern: /src-ui\/src\/contexts\/ToastContext\.tsx?$/,
    overrides: 'export const useToast = () => ({ showToast() {} });',
  },
  {
    pattern: /src-ui\/src\/hooks\/useToolApproval\.tsx?$/,
    overrides: 'export const useToolApproval = () => () => {};',
  },
  {
    pattern: /src-ui\/src\/hooks\/useActiveChatSessions\.tsx?$/,
    overrides: 'export const useSendMessage = () => async () => true;',
  },
  {
    pattern: /src-ui\/src\/components\/chat\/SessionSummaryCard\.tsx?$/,
    overrides: 'export const SessionSummaryCard = () => null;',
  },
];

const shellStubs: Plugin = {
  name: 'turn-rail-shell-stubs',
  setup(build) {
    build.onResolve({ filter: /\.css$/ }, (args) => ({
      path: args.path,
      namespace: 'turn-rail-empty-css',
    }));
    build.onLoad({ filter: /.*/, namespace: 'turn-rail-empty-css' }, () => ({
      contents: '',
      loader: 'js',
    }));
    build.onResolve(
      {
        filter:
          /(AgentsContext|ApiBaseContext|AuthContext|ToastContext|useToolApproval|useActiveChatSessions|SessionSummaryCard)$/,
      },
      async (args) => {
        if (args.namespace === 'turn-rail-stub' || args.pluginData?.real)
          return undefined;
        const real = await build.resolve(args.path, {
          resolveDir: args.resolveDir,
          kind: args.kind,
          importer: args.importer,
          pluginData: { real: true },
        });
        const stub = STUBS.find((candidate) =>
          candidate.pattern.test(real.path.replaceAll('\\', '/')),
        );
        if (!stub || real.errors.length > 0) return undefined;
        return {
          path: real.path,
          namespace: 'turn-rail-stub',
          pluginData: stub,
        };
      },
    );
    build.onLoad({ filter: /.*/, namespace: 'turn-rail-stub' }, (args) => ({
      contents: `export * from ${JSON.stringify(args.path)};\n${
        (args.pluginData as (typeof STUBS)[number]).overrides
      }`,
      loader: 'tsx',
      resolveDir: dirname(args.path),
    }));
  },
};

let cachedCss: string | undefined;
function appCss(): string {
  if (cachedCss) return cachedCss;
  const css = [
    'src-ui/src/index.css',
    'src-ui/src/components/chat/chat.css',
    'src-ui/src/components/chat/TranscriptTurnRail.css',
  ]
    .map((path) => resolveCssImports(resolve(ROOT, path)))
    .join('\n');
  assertNoImportsSurvive(css);
  cachedCss = css;
  return css;
}

export interface TurnRailFixtureOptions {
  readonly turns: number;
  /** Desktop dock (1280x800) or phone (390x844). */
  readonly viewport: { width: number; height: number };
  /** Height of the dock body the transcript fills. */
  readonly dockHeight: number;
}

/**
 * The real ChatMessageList (real virtualizer, real MessageBubble rows, real
 * stylesheets) in Chromium, inside a dock-shaped column whose composer
 * activity row receives the scroll controls, as ChatDockBody's does.
 * `window.__growTail()` grows the newest reply the way a projected live turn
 * streams; `window.__session` is the current session.
 */
export async function turnRailBrowserFixture({
  turns,
  viewport,
  dockHeight,
}: TurnRailFixtureOptions) {
  const fixture = await scrollBrowserFixture(
    `
    import React, {useState, useEffect} from 'react';
    import {createRoot} from 'react-dom/client';
    import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
    import {ChatMessageList} from './src-ui/src/components/chat/ChatMessageList';
    const TOPICS = ['the deploy script','flaky retry tests','the session store','a migration plan','the release notes','the inbox filters','dock resize behaviour','the approval queue'];
    function makeMessages(turns){
      const messages=[];
      for(let k=0;k<turns;k++){
        const topic=TOPICS[k%TOPICS.length];
        messages.push({id:'u-'+k,role:'user',content:'Turn '+(k+1)+': can you look at '+topic+' and tell me what changed since the last pass?',timestamp:1000+k*2});
        const paragraphs=1+(k*7)%4;
        const failed=k===9;
        messages.push({id:'a-'+k,role:'assistant',turnId:'turn-'+k,content:failed?'':Array.from({length:paragraphs},(_,p)=>'Reply '+(k+1)+'.'+(p+1)+': I read '+topic+' end to end. The change narrows the retry window, keeps the existing owner, and leaves the public contract alone. Nothing else in this area moved.').join('\\n\\n'),
          contentParts:failed?[{type:'text',content:'The engine stopped with an error before it finished this turn.',runtimeError:true}]:undefined,
          timestamp:1001+k*2});
      }
      return messages;
    }
    const base={id:'turn-rail-session',agentSlug:'dev-agent',agentName:'Dev Agent',title:'Turn rail',input:'',attachments:[],queuedMessages:[],inputHistory:[],hasUnread:false,status:'idle',createdAt:1,updatedAt:1,source:'manual'};
    const client=new QueryClient({defaultOptions:{queries:{retry:false,enabled:false}}});
    function App(){
      const [session,setSession]=useState(()=>({...base,messages:makeMessages(${turns})}));
      const [activity,setActivity]=useState(null);
      useEffect(()=>{
        window.__session=session;
        window.__growTail=()=>setSession(current=>{
          const messages=[...current.messages];
          const last=messages[messages.length-1];
          messages[messages.length-1]={...last,content:last.content+'\\n\\nMore streamed text arrives for the newest turn while the reader is elsewhere.'};
          return {...current,messages};
        });
      },[session]);
      return <QueryClientProvider client={client}>
        <div className="chat-dock__body" style={{height:${dockHeight},display:'flex',flexDirection:'column'}}>
          <ChatMessageList activeSession={session} fontSize={14} showReasoning={false} showToolDetails={false} scrollControlsTarget={activity}/>
          <div className="chat-input" style={{flex:'none'}}><div className="chat-input__meta" style={{display:'flex',minHeight:44,padding:8}}><div className="chat-input__activity" ref={setActivity}/></div></div>
        </div>
      </QueryClientProvider>;
    }
    document.documentElement.dataset.theme='dark';
    createRoot(document.getElementById('root')).render(<App/>);
  `,
    [shellStubs],
  );
  await fixture.page.setViewportSize(viewport);
  await fixture.page.addStyleTag({ content: appCss() });
  return fixture;
}
