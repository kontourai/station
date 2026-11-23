/**
 * The real ChatMessageList, the real ChatInputArea (its status row holding
 * the real ChatStatusPill) and the real stylesheets in Chromium, inside a
 * `.chat-dock__body` the size of the viewport (or `dockHeight`). Six (or
 * more) turns, each answer with a completed `ls` tool row.
 *
 * - `window.__setStatus(kind?)` shows or clears a status (`catching-up`,
 *   `working`, `unavailable`).
 * - `window.__setNotice(kind?)` shows or clears what can sit between the
 *   transcript and the composer: the real recovery notice ("Couldn't check
 *   this chat"), the pending list's markup, the stream status line, or the wait
 *   row with Check again.
 * - `window.__setRequest(kind?)` opens an approval or an input request,
 *   which the transcript shows as a card at its end.
 * - `window.__setNextTurn(on)` shows the next-turn notice in the status row.
 * - `window.__appendTurn()` adds a new turn at the tail.
 * - `window.__streamTail(text)` appends text to the newest answer, as a
 *   streaming answer grows.
 * - `window.__sendUser(text)` appends the reader's own message;
 *   `window.__answer(text)` appends a new answer (no message of theirs).
 * - `window.__switchSession()` shows another chat (one turn fewer) in the
 *   same list.
 *
 * Needs a cached Chromium (PLAYWRIGHT_BROWSERS_PATH); never downloads.
 */
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import type { Plugin } from 'esbuild';
import { expect } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';
import { appCss, shellStubs } from './transcript-turn-rail-fixture';

export const DESKTOP = { width: 1440, height: 900 };
export const PHONE = { width: 390, height: 844 };
export const SMALL_PHONE = { width: 320, height: 640 };

export const VIEWPORTS = [
  ['1440', DESKTOP],
  ['390', PHONE],
  ['320', SMALL_PHONE],
] as const;
export const THEMES = ['light', 'dark'] as const;

// The composer's controls that need an API provider are stubbed; the status
// row, the draft and the controls row are real.
const composerControls: Plugin = {
  name: 'composer-controls',
  setup(builder) {
    const modules: Record<string, string> = {
      KeyboardShortcutsContext: 'export const setShortcutContext = () => {};',
      UnconfirmedDiscardConfirm:
        'export const UnconfirmedDiscardConfirm=()=>null; export const useUnconfirmedDiscardDisclosure=()=>({});',
      ModelSelector: 'export const ModelSelectorAutocomplete=()=>null;',
    };
    for (const name of [
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
    ])
      modules[name] = `export const ${name}=()=>null;`;
    builder.onResolve({ filter: /./ }, (args) => {
      const name = args.path.split('/').at(-1)!;
      return name in modules
        ? { path: name, namespace: 'composer-controls' }
        : undefined;
    });
    builder.onLoad(
      { filter: /.*/, namespace: 'composer-controls' },
      (args) => ({ contents: modules[args.path], loader: 'tsx' }),
    );
  },
};

export interface TailFixtureOptions {
  readonly turns?: number;
  readonly theme?: 'light' | 'dark';
  /** The dock body's height in px; the viewport's when absent. */
  readonly dockHeight?: number;
  /** `no-preference` for smooth keyboard scrolling and the glide. */
  readonly reducedMotion?: 'reduce' | 'no-preference';
}

export async function tailFixture(
  viewport: { width: number; height: number },
  options: TailFixtureOptions | number = {},
) {
  const {
    turns = 6,
    theme = 'dark',
    dockHeight,
    reducedMotion = 'reduce',
  } = typeof options === 'number' ? { turns: options } : options;
  const fixture = await scrollBrowserFixture(
    `
    import React, {useState, useEffect, useRef} from 'react';
    import {createRoot} from 'react-dom/client';
    import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
    import {ChatMessageList} from './src-ui/src/components/chat/ChatMessageList';
    import {ChatInputArea} from './src-ui/src/components/chat/ChatInputArea';
    import {ConversationOpenRecoveryNotice} from './src-ui/src/components/chat-dock/ConversationOpenRecoveryNotice';
    import {ChatStatusPill} from './src-ui/src/components/status/ChatStatusPill';
    const output = Array.from({length: 40}, (_, i) => 'file-' + i + '.ts').join('\\n');
    function makeMessages(){
      const messages=[];
      for(let k=0;k<${turns};k++){
        messages.push({id:'u-'+k,role:'user',content:'Turn '+(k+1)+': what changed in the deploy script since the last pass?',timestamp:1000+k*2});
        messages.push({id:'a-'+k,role:'assistant',turnId:'turn-'+k,timestamp:1001+k*2,
          content:'Reply '+(k+1)+': the change narrows the retry window and keeps the existing owner. Nothing else in this area moved.',
          contentParts:[
            {type:'tool-invocation',toolCallId:'call-'+k,toolName:'shell_exec',args:{command:'ls'},result:output,state:'completed'},
            {type:'text',content:'Reply '+(k+1)+': the change narrows the retry window and keeps the existing owner. Nothing else in this area moved.'},
          ]});
      }
      return messages;
    }
    const STATUS={
      'catching-up':{kind:'catching-up',tone:'neutral',glyph:'reconnecting',label:'Catching up',details:[{text:'Live updates are catching up.'}],action:'details'},
      working:{kind:'working',tone:'active',glyph:'working',label:'Working',details:[],action:undefined},
      unavailable:{kind:'blocked',tone:'broken',glyph:'attention',label:'Status unavailable',details:[{text:'Station could not verify this conversation.'}],action:'resync'},
    };
    let sequence=0;
    function requestEvents(kind){
      const event=(fields)=>{sequence+=1;return {event:{eventId:'evt-'+sequence,provider:'claude',threadId:'tail-child',createdAt:'2026-11-01T00:00:'+String(sequence).padStart(2,'0')+'.000Z',...fields}};};
      return [
        event({method:'turn.started',turnId:'turn-req',prompt:'go'}),
        kind==='input'
          ? event({method:'request.opened',requestId:'req-input',requestType:'input',title:'Which branch should I use?',payload:{}})
          : event({method:'request.opened',requestId:'req-approval',requestType:'approval',title:'Allow Bash',payload:{toolName:'Bash',toolCallId:'sub-call',agentId:'a1'}}),
      ];
    }
    const base={id:'tail-session',agentSlug:'dev-agent',agentName:'Dev Agent',title:'Tail',input:'',attachments:[],queuedMessages:[],inputHistory:[],status:'idle',createdAt:1,updatedAt:1,source:'manual'};
    const client=new QueryClient({defaultOptions:{queries:{retry:false,enabled:false}}});
    const noop=()=>{};
    function Notice({kind}){
      if(kind==='recovery') return <ConversationOpenRecoveryNotice title="Tail" state="unverified" onRetry={noop} onStartNew={noop}/>;
      // The pending list's dock markup (QueuedMessages hangs this harness
      // without the app's stores): its presence wrapper, a row and its control.
      if(kind==='queued') return <div className="queued-messages-presence"><div className="queued-presence__clip"><section className="queued-messages" aria-label="Pending messages"><div className="queued-messages__toggle">1 pending</div><ol className="queued-messages__list"><li>Also check the release notes. <button type="button" className="button button--secondary">Send now</button></li></ol></section></div></div>;
      if(kind==='stream-status') return <div className="chat-stream-status" role="status"><span>Your decision is recorded, but the engine has not acknowledged it yet.</span></div>;
      if(kind==='wait') return <div className="session-history-controls" role="status"><span>Waiting for the active turn to finish.</span><button type="button" className="button button--secondary">Check again</button></div>;
      return null;
    }
    function App(){
      const [session,setSession]=useState(()=>({...base,messages:makeMessages()}));
      const [status,setStatus]=useState(undefined);
      const [notice,setNotice]=useState(undefined);
      const [request,setRequest]=useState(undefined);
      const [nextTurn,setNextTurn]=useState(false);
      const [activity,setActivity]=useState(null);
      const textareaRef=useRef(null);
      useEffect(()=>{
        window.__setStatus=kind=>setStatus(kind?STATUS[kind]:undefined);
        window.__setNotice=kind=>setNotice(kind);
        window.__setRequest=kind=>setRequest(kind);
        window.__setNextTurn=on=>setNextTurn(on);
        window.__appendTurn=()=>setSession(current=>({...current,messages:[...current.messages,
          {id:'u-new',role:'user',content:'One more question about the release notes.',timestamp:5000},
          {id:'a-new',role:'assistant',turnId:'turn-new',content:'A new answer arrives at the tail.',timestamp:5001}]}));
        window.__sendUser=text=>setSession(current=>({...current,messages:[...current.messages,
          {id:'u-sent-'+current.messages.length,role:'user',content:text,timestamp:9000+current.messages.length}]}));
        window.__answer=text=>setSession(current=>({...current,messages:[...current.messages,
          {id:'a-sent-'+current.messages.length,role:'assistant',turnId:'turn-sent-'+current.messages.length,content:text,timestamp:9000+current.messages.length}]}));
        window.__switchSession=()=>setSession(()=>({...base,id:'tail-session-2',messages:makeMessages().slice(2)}));
        window.__streamTail=text=>setSession(current=>{
          const messages=[...current.messages];
          const last={...messages[messages.length-1]};
          last.content=(last.content||'')+text;
          if(last.contentParts){
            const parts=[...last.contentParts];
            const end=parts.length-1;
            parts[end]={...parts[end],content:parts[end].content+text};
            last.contentParts=parts;
          }
          messages[messages.length-1]=last;
          return {...current,messages};
        });
      },[]);
      return <QueryClientProvider client={client}>
        <div className="chat-dock__body" style={{height:${dockHeight ? `${dockHeight}` : "'100vh'"},flex:'none',display:'flex',flexDirection:'column'}}>
          <ChatMessageList activeSession={session} fontSize={14} showReasoning={false} showToolDetails scrollControlsTarget={activity}
            approvalEvents={request?requestEvents(request):[]} approvalEventsSettled/>
          <Notice kind={notice}/>
          <ChatInputArea agentSlug="dev-agent" sessionId="tail-session" input="" textareaRef={textareaRef} attachments={[]} disabled={false} turnInFlight={false} modelSupportsAttachments={true} fontSize={14} dockHeight={${dockHeight ?? viewport.height}} apiBase="http://station.test" canModelSelect={true}
            availableModels={[{id:'mini',name:'Mini'}]} agentDefaultModel="mini" modelQuery={null} commandQuery={null} slashCommands={[]}
            agentLabel="Dev Agent" agentIcon={<svg width="24" height="24"/>}
            agentEngineMove={nextTurn?{to:'Codex',nextTurn:true}:undefined}
            activityRef={setActivity}
            activity={<ChatStatusPill status={status} onResync={noop}/>}
            onInputChange={noop} onSend={noop} onCancel={noop} onClearInput={noop} selectAttachmentFiles={noop} onRemoveAttachment={noop} onClearAttachments={noop} onModelSelect={noop} onModelReset={noop} onModelClose={noop} onModelOpen={noop} onModelRuntimeOptionChange={noop} onApprovalModeChange={noop} onCommandSelect={noop} onCommandClose={noop} onHistoryUp={noop} onHistoryDown={noop} onShowStats={noop} updateFromInput={noop} closeAll={noop}/>
        </div>
      </QueryClientProvider>;
    }
    document.documentElement.dataset.theme=${JSON.stringify(theme)};
    createRoot(document.getElementById('root')).render(<App/>);
  `,
    [shellStubs, composerControls],
    { viewport, reducedMotion },
  );
  await fixture.page.addStyleTag({ content: appCss() });
  // Stylesheets the app's components import beside the chat's own.
  for (const sheet of [
    '../components/status/live-status.css',
    '../components/chat/QueuedMessages.css',
    '../components/chat-dock/ConversationOpenRecoveryNotice.css',
  ])
    await fixture.page.addStyleTag({
      content: resolveCssImports(resolve(import.meta.dirname, sheet)),
    });
  await fixture.page.locator('.chat-input').waitFor();
  return fixture;
}

export function frames(page: Page, count = 12) {
  return page.evaluate(
    `new Promise((resolve) => { let left = ${count}; const tick = () => (--left ? requestAnimationFrame(tick) : resolve()); requestAnimationFrame(tick); })`,
  );
}

async function callWindow(page: Page, name: string, value: unknown) {
  await page.evaluate(
    ([fn, arg]) =>
      (window as unknown as Record<string, (v: unknown) => void>)[
        fn as string
      ]!(arg),
    [name, value] as const,
  );
}

export type StatusKind = 'catching-up' | 'working' | 'unavailable';
const PILL_KIND: Record<StatusKind, string> = {
  'catching-up': 'catching-up',
  working: 'working',
  unavailable: 'blocked',
};

export const pill = (page: Page, kind: StatusKind) =>
  page.locator(`[data-chat-status-pill="${PILL_KIND[kind]}"]`);

export async function setStatus(page: Page, kind?: StatusKind) {
  await callWindow(page, '__setStatus', kind);
  if (kind) await pill(page, kind).waitFor();
  else
    await page
      .locator('[data-chat-status-pill]')
      .waitFor({ state: 'detached' });
  await frames(page);
}

export type NoticeKind = 'recovery' | 'queued' | 'stream-status' | 'wait';
export async function setNotice(page: Page, kind?: NoticeKind) {
  await callWindow(page, '__setNotice', kind);
  await frames(page);
}

export async function setRequest(page: Page, kind?: 'approval' | 'input') {
  await callWindow(page, '__setRequest', kind);
  await frames(page);
}

export async function setNextTurn(page: Page, on: boolean) {
  await callWindow(page, '__setNextTurn', on);
  await frames(page);
}

export const transcript = (page: Page) =>
  page.getByRole('log', { name: 'Conversation transcript' });
export const lastToolRow = (page: Page) =>
  transcript(page)
    .getByRole('button', { name: /Ran ls/ })
    .last();

/** Distance from the transcript's end, in px (0 when pinned). */
export function distanceFromEnd(page: Page) {
  return transcript(page).evaluate(
    (element) =>
      element.scrollHeight - element.scrollTop - element.clientHeight,
  );
}

export async function settledAtTail(page: Page) {
  await lastToolRow(page).waitFor();
  await frames(page);
  // Opened inside the pinned tolerance can leave the end a few px away (the
  // composer reserving its room after the first pin, on main too); the reader
  // wheels to the very end, as they would.
  const log = (await transcript(page).boundingBox())!;
  await page.mouse.move(log.x + log.width / 2, log.y + log.height / 2);
  await page.mouse.wheel(0, 4000);
  await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);
  // Past the wheel's input grace, so later growth is not the reader's.
  await page.waitForTimeout(400);
  await frames(page);
}

export async function rowTop(page: Page) {
  return (await lastToolRow(page).boundingBox())!.y;
}
