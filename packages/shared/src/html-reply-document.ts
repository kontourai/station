import type { HtmlReplyReference } from '@kontourai/station-contracts/html-reply';
import { HTML_REPLY_THEME_KEYS } from '@kontourai/station-contracts/html-reply';
import { buildMcpUiCsp, MCP_UI_NETWORK_BOOTSTRAP_TAG } from './mcp-ui-csp.js';

const json = (value: unknown) =>
  JSON.stringify(value).replaceAll('<', '\\u003c');

/** CSP precedes every byte of agent HTML, including its own head/meta tags. */
export function buildHtmlReplyDocument(
  html: string,
  previewToken?: string,
): string {
  const diagnostics = previewToken
    ? `<script>(()=>{const token=${json(previewToken)};document.currentScript.remove();const post=value=>parent.postMessage({...value,token},'*');const emit=(level,text,stack)=>{if(text.length>65536){post({type:'html-preview-overflow'});return;}post({type:'html-preview-console',level,text,stack});};for(const level of ['log','warn','error']){const original=console[level].bind(console);console[level]=(...args)=>{let text;try{text=args.map(arg=>typeof arg==='string'?arg:JSON.stringify(arg)).join(' ')}catch{text='[Unserializable console arguments]'}emit(level==='warn'?'warning':level,text,new Error().stack);original(...args);};}addEventListener('error',event=>emit('uncaught',event.message,event.error?.stack));addEventListener('unhandledrejection',event=>emit('uncaught',String(event.reason),event.reason?.stack));addEventListener('load',()=>{const measure=()=>post({type:'html-preview-size',height:Math.ceil(Math.max(document.documentElement.scrollHeight,document.body.scrollHeight))});new ResizeObserver(measure).observe(document.body);measure();});})();</script>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${buildMcpUiCsp()}">${MCP_UI_NETWORK_BOOTSTRAP_TAG}<style>html{background:var(--background);color:var(--foreground);font-family:var(--font-sans)}body{margin:0}</style><script>(()=>{'use strict';const keys=${json(HTML_REPLY_THEME_KEYS)};addEventListener('message',event=>{if(event.source!==parent||event.data?.type!=='html-reply-theme')return;const values=event.data.tokens;for(const key of keys){const value=values?.[key];if(typeof value==='string'&&value.length<=256)document.documentElement.style.setProperty('--'+key,value);}document.documentElement.style.colorScheme=event.data.theme==='light'?'light':'dark';});document.addEventListener('click',event=>{const link=event.target instanceof Element?event.target.closest('a[href]'):null;if(!link)return;event.preventDefault();if(!event.isTrusted)return;try{const url=new URL(link.getAttribute('href'));if(['https:','http:'].includes(url.protocol)&&url.href.length<=2048)parent.postMessage({type:'html-reply-link',url:url.href},'*');}catch{}},true);})();</script></head><body>${diagnostics}${html}</body></html>`;
}

/**
 * Page-only proxy on the existing asset-free MCP sandbox origin. There is no
 * MCP AppBridge and no tool/session API. The host must confirm link requests:
 * a malicious page can manufacture any message its own bootstrap can send.
 */
export function buildHtmlReplyProxyDocument(
  parentOrigins: readonly string[],
): string {
  const prefix = buildHtmlReplyDocument('');
  // Insert authored bytes after the complete trusted head, inside the body.
  const bodyOffset = prefix.lastIndexOf('</body>');
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body,iframe{border:0;margin:0;width:100%;height:100%;display:block}</style></head><body><script>(()=>{'use strict';const allowed=new Set(${json(parentOrigins)});let host=null,inner=null,tokens={},theme='dark';const post=value=>{if(host)parent.postMessage(value,host.origin==='null'?'*':host.origin);};const appearance=()=>{inner?.contentWindow?.postMessage({type:'html-reply-theme',tokens,theme},'*');};addEventListener('message',event=>{if(event.source===parent){if(!host){if(!allowed.has(event.origin)&&!(event.origin==='null'&&allowed.has('tauri://localhost')))return;host={origin:event.origin};}if(event.origin!==host.origin)return;const data=event.data;if(data?.type==='html-reply-connect'){post({type:'html-reply-ready'});return;}if(data?.type==='html-reply-load'&&typeof data.html==='string'&&new TextEncoder().encode(data.html).length<=8388608){const frame=document.createElement('iframe');frame.title='Visual reply';frame.sandbox.value='allow-scripts';frame.referrerPolicy='no-referrer';frame.srcdoc=${json(prefix.slice(0, bodyOffset))}+data.html+${json(prefix.slice(bodyOffset))};frame.addEventListener('load',appearance);inner?.remove();inner=frame;document.body.append(frame);}if(data?.type==='html-reply-theme'){tokens=data.tokens;theme=data.theme;appearance();}return;}if(!inner||event.source!==inner.contentWindow)return;const data=event.data;if(data?.type==='html-reply-link'&&navigator.userActivation?.isActive&&typeof data.url==='string'&&data.url.length<=2048){try{const url=new URL(data.url);if(url.protocol==='https:'||url.protocol==='http:')post({type:'html-reply-link',url:url.href});}catch{}}});for(const origin of allowed)parent.postMessage({type:'html-reply-ready'},origin==='tauri://localhost'?'*':origin);})();</script></body></html>`;
}

/** Only the small tool result is projected; page bytes are read with current auth. */
export function htmlReplyReference(
  value: unknown,
  depth = 0,
): HtmlReplyReference | undefined {
  if (depth > 6) return undefined;
  if (typeof value === 'string') {
    if (value.length > 64 * 1024) return undefined;
    try {
      return htmlReplyReference(JSON.parse(value), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;
  if ('htmlReply' in value) {
    const ref = value.htmlReply;
    if (
      ref &&
      typeof ref === 'object' &&
      'version' in ref &&
      ref.version === 1 &&
      'pageId' in ref &&
      typeof ref.pageId === 'string' &&
      /^[0-9a-f-]{36}$/i.test(ref.pageId) &&
      'sessionId' in ref &&
      typeof ref.sessionId === 'string' &&
      ref.sessionId.length > 0 &&
      ref.sessionId.length <= 512
    )
      return { version: 1, pageId: ref.pageId, sessionId: ref.sessionId };
  }
  const nested = [
    'value' in value ? value.value : undefined,
    'structuredContent' in value ? value.structuredContent : undefined,
    'output' in value ? value.output : undefined,
    'result' in value ? value.result : undefined,
    'text' in value ? value.text : undefined,
  ];
  for (const candidate of nested) {
    const reference = htmlReplyReference(candidate, depth + 1);
    if (reference) return reference;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const ref = htmlReplyReference(item, depth + 1);
      if (ref) return ref;
    }
  }
  if ('content' in value && Array.isArray(value.content))
    for (const item of value.content) {
      const ref = htmlReplyReference(item, depth + 1);
      if (ref) return ref;
    }
  return undefined;
}
