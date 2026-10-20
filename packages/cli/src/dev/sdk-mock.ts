export interface SDKMockConfig {
  layoutSlug: string;
}

/** Serialize the SDK mock object to a JS string for injection into dev HTML */
export function serializeSDKMock(config: SDKMockConfig): string {
  const { layoutSlug } = config;
  return `
// Toast overlay
var noop=function(){};
(function(){var c=document.createElement('div');c.className='dev-toast-container';document.body.appendChild(c);window.__devToast=function(msg){var el=document.createElement('div');el.className='dev-toast';el.textContent=msg;c.appendChild(el);setTimeout(function(){el.remove()},4000)};})();

// Provider registry — plugin's own code registers here
var __p={},__pc={};

// SDK mock — matches @kontourai/station-sdk exports used by plugins
// Standalone functions (not hooks) — also exposed on the mock object for the shim
var __devApiBase='';
function __callTool(slug,tool,args){return fetch('/agents/'+encodeURIComponent(slug)+'/tools/'+encodeURIComponent(tool),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args||{})}).then(function(r){return r.json()}).then(function(d){if(!d.success)throw new Error(d.error||'Tool call failed');return d.response})}
function __invokeAgent(slug,prompt){window.__devToast&&window.__devToast('→ agent('+slug+'): '+prompt.slice(0,100));return Promise.resolve({text:'[mock]',toolCalls:[]})}
function __invoke(opts){window.__devToast&&window.__devToast('invoke: '+JSON.stringify(opts).slice(0,120));return Promise.resolve({})}
// Host services — the same contract Station's adapter supplies: promises that
// resolve (never reject), http(s)-only external links, and kernel-reserved
// shortcut chords refused (command palette, Settings, shortcut list).
var __isMac=typeof navigator!=='undefined'&&/mac/i.test(navigator.platform||'');
var __shortcutName=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function __chord(keys){var m={};(keys.modifiers||[]).forEach(function(x){m[!__isMac&&x==='cmd'?'ctrl':x]=1});return Object.keys(m).sort().join('+')+'|'+String(keys.key).toLowerCase()}
var __reservedChords={};[['command-palette','k'],['app.settings',','],['app.shortcuts','/']].forEach(function(r){__reservedChords[__chord({key:r[1],modifiers:['cmd']})]=r[0]});
function __checkShortcut(s){
  if(typeof s.id!=='string'||!__shortcutName.test(s.id))return{ok:false,reason:'invalid-id',message:'A shortcut id is 1-64 letters, digits, "-" or "_", starting with a letter or digit.'};
  var k=s.keys;if(!k||typeof k.key!=='string'||!k.key.trim()||!Array.isArray(k.modifiers))return{ok:false,reason:'invalid-keys',message:'A shortcut needs a key and distinct modifiers from cmd, ctrl, shift and alt.'};
  var hit=__reservedChords[__chord(k)];if(hit)return{ok:false,reason:'reserved',message:'This chord belongs to Station\\'s "'+hit+'" shortcut, which plugins cannot override.'};
  return{ok:true,registryId:'plugin.dev.'+s.id};
}
function __matches(e,k){var m=k.modifiers||[];var cmd=m.indexOf('cmd')>=0,ctrl=m.indexOf('ctrl')>=0;return e.metaKey===(__isMac&&cmd)&&e.ctrlKey===(ctrl||(!__isMac&&cmd))&&e.shiftKey===(m.indexOf('shift')>=0)&&e.altKey===(m.indexOf('alt')>=0)&&String(e.key).toLowerCase()===String(k.key).toLowerCase()}
function __useShortcut(s){var R=window.React;var run=R.useRef(s.run);run.current=s.run;var res=__checkShortcut(s);var ok=res.ok,en=s.enabled!==false,key=s.keys&&s.keys.key,mods=s.keys&&(s.keys.modifiers||[]).join('|');
  R.useEffect(function(){if(!ok){console.warn('Station refused shortcut "'+s.id+'": '+res.message);return}if(!en)return;var k={key:key,modifiers:mods?mods.split('|'):[]};function h(e){if(e.defaultPrevented||!__matches(e,k))return;if(run.current()!==false)e.preventDefault()}window.addEventListener('keydown',h);return function(){window.removeEventListener('keydown',h)}},[ok,en,key,mods]);
  return res}
var __mobileQuery='(max-width: 768px), (max-height: 540px) and (pointer: coarse)';
function __readFacts(){return{device:{isMobile:!!(window.matchMedia&&window.matchMedia(__mobileQuery).matches)}}}
function __useHostFacts(){var R=window.React;var st=R.useState(__readFacts),f=st[0],set=st[1];R.useEffect(function(){if(!window.matchMedia)return;var mq=window.matchMedia(__mobileQuery);var h=function(){set(__readFacts())};mq.addEventListener('change',h);return function(){mq.removeEventListener('change',h)}},[]);return f}
var __host={
  clipboard:{writeText:function(t){try{var c=navigator.clipboard;if(!c||typeof c.writeText!=='function')return Promise.resolve(false);return c.writeText(t).then(function(){return true},function(){return false})}catch(e){return Promise.resolve(false)}}},
  openExternal:function(url){var p;try{p=new URL(url).protocol}catch(e){p=''}if(p!=='http:'&&p!=='https:'){window.__devToast&&window.__devToast('Station only opens web (http or https) links: '+url);return Promise.resolve(false)}window.open(url,'_blank','noopener,noreferrer');return Promise.resolve(true)},
  prompt:function(r){var v=window.prompt((r.title||'')+(r.label?'\\n'+r.label:''),r.initial||'');v=v==null?'':String(v).trim();return Promise.resolve(v?v:null)},
  confirm:function(r){return Promise.resolve(window.confirm((r.title||'')+'\\n'+(r.message||''))?'confirmed':'cancelled')}
};
function __serverFetch(url,opts){return fetch('/api/plugins/fetch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:url,method:opts&&opts.method,headers:opts&&opts.headers,body:opts&&opts.body})}).then(function(r){return r.json()}).then(function(d){if(!d.success)throw new Error(d.error);return d})}

window.__station_ai_sdk_mock={
  // Hooks
  useAgents:function(){return[]},
  useAuth:function(){return{status:'valid',provider:'none',user:{alias:'dev-user',name:'Dev User'},expiresAt:null,renew:function(){return Promise.resolve()},isRenewing:false}},
  useConversations:function(){return[]},
  useOpenConversation:function(){return noop},
  useNavigation:function(){return{pathname:window.location.pathname,selectedAgent:null,selectedLayout:'${layoutSlug}',activeConversation:null,activeChat:null,activeTab:null,isDockOpen:false,isDockMaximized:false,fontSize:null,navigate:noop,updateParams:noop,setAgent:noop,setLayout:noop,setLayoutTab:function(ws,tab){if(window.__devSetTab)window.__devSetTab(tab)},setConversation:noop,setActiveChat:noop,setDockState:noop}},
  useDockState:function(){return{isOpen:false,setOpen:noop,toggle:noop}},
  useToast:function(){return{showToast:function(msg,opts){window.__devToast&&window.__devToast((opts&&opts.type?opts.type+': ':'')+msg)}}},
  useNotifications:function(){return{notify:function(msg,opts){window.__devToast&&window.__devToast((opts&&opts.type?opts.type+': ':'')+msg)},schedule:function(opts){window.__devToast&&window.__devToast('Notification: '+opts.title+(opts.body?' — '+opts.body:''));return Promise.resolve({id:'mock-'+Date.now(),source:'sdk',category:opts.category||'info',title:opts.title,status:opts.scheduledAt?'pending':'delivered',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})},dismiss:function(){return Promise.resolve()}}},
  useLayoutQuery:function(){return{data:undefined}},
  useLayoutNavigation:function(){var ls='${layoutSlug}';return{getTabState:function(t){return sessionStorage.getItem('layout-'+ls+'-tab-'+t)||''},setTabState:function(t,s){var key='layout-'+ls+'-tab-'+t;sessionStorage.setItem(key,s)},clearTabState:function(t){sessionStorage.removeItem('layout-'+ls+'-tab-'+t)}}},
  useSendToChat:function(slug){return function(msg){window.__devToast&&window.__devToast('→ chat('+slug+'): '+(typeof msg==='string'?msg:JSON.stringify(msg).slice(0,120)))}},
  useApiBase:function(){return __devApiBase},
  useHost:function(){return __host},
  useHostFacts:__useHostFacts,
  useShortcut:__useShortcut,
  useShortcutScope:function(){},
  useServerFetch:function(){return __serverFetch},
  // Standalone functions
  callTool:__callTool,
  invokeAgent:__invokeAgent,
  invoke:__invoke,
  // Provider registry
  registerProvider:function(id,meta,factory){__p[id]={meta:meta,factory:factory,instance:null}},
  configureProvider:function(ws,type,pid){__pc[ws+'/'+type]=pid},
  hasProvider:function(ws,type){var pid=__pc[ws+'/'+type];return !!pid&&!!__p[pid]},
  getProvider:function(ws,type){var pid=__pc[ws+'/'+type];if(!pid||!__p[pid])return null;var e=__p[pid];if(!e.instance)e.instance=typeof e.factory==='function'?e.factory():e.factory;return e.instance},
  getActiveProviderId:function(ws,type){return __pc[ws+'/'+type]||null},
  // Layout context factory
  createLayoutContext:function(opts){var init=(opts&&opts.initialState)||{};var R=window.React;var _state=Object.assign({},init);var _listeners=[];function _set(partial){Object.assign(_state,partial);_listeners.forEach(function(l){l()});}var Ctx=R.createContext({state:_state,setState:_set});return{Provider:function(p){var ref=R.useState(0),tick=ref[1];R.useEffect(function(){var l=function(){tick(function(n){return n+1})};_listeners.push(l);return function(){_listeners=_listeners.filter(function(x){return x!==l})}},[]);return R.createElement(Ctx.Provider,{value:{state:_state,setState:_set}},p.children)},useLayoutContext:function(){return R.useContext(Ctx)}}},
  // Components
  Button:function(props){return window.React.createElement('button',{onClick:props.onClick,disabled:props.disabled,className:'layout-dashboard__btn'+(props.variant?' layout-dashboard__btn--'+props.variant:''),style:props.style},props.children)},
};`;
}
