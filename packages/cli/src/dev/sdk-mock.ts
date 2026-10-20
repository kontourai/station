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
// Host services: the contract Station's adapter supplies. Promises resolve
// (never reject); external links are http(s) only, credential-free and
// normalised; shortcuts get Station's refusals (ids, keys, when, reserved
// kernel and text-editing chords), modal suppression, the text-field guard,
// and plugin-owned scopes. There are no Station shortcuts here to outrank.
var __isMac=typeof navigator!=='undefined'&&/mac/i.test(navigator.platform||'');
var __shortcutName=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
var __modifierNames={cmd:1,ctrl:1,shift:1,alt:1};
var __hostKeys={composerFocused:1,terminalFocused:1,dialogOpen:1,dockFocused:1};
var __scopes={};
function __modalOpen(){return !!document.querySelector('[aria-modal="true"]')}
function __chord(keys){var m={};(keys.modifiers||[]).forEach(function(x){m[!__isMac&&x==='cmd'?'ctrl':x]=1});return Object.keys(m).sort().join('+')+'|'+String(keys.key).toLowerCase()}
var __reservedChords={};
[['command-palette','k',['cmd']],['app.settings',',',['cmd']],['app.shortcuts','/',['cmd']],['editing.copy','c',['cmd']],['editing.paste','v',['cmd']],['editing.cut','x',['cmd']],['editing.undo','z',['cmd']],['editing.redo','z',['cmd','shift']],['editing.selectAll','a',['cmd']]].forEach(function(r){__reservedChords[__chord({key:r[1],modifiers:r[2]})]=r[0]});
function __whenValid(w,d){if(d>8)return false;if(typeof w==='string')return !!__hostKeys[w]||__shortcutName.test(w);if(!w||typeof w!=='object')return false;if('not' in w)return __whenValid(w.not,d+1);var l=w.and||w.or;return Array.isArray(l)&&l.every(function(x){return __whenValid(x,d+1)})}
function __whenTrue(w,d){if(d>8)return false;if(typeof w==='string'){if(w==='dialogOpen')return __modalOpen();if(__hostKeys[w])return false;return (__scopes[w]||0)>0}if('not' in w)return !__whenTrue(w.not,d+1);if(w.and)return w.and.every(function(x){return __whenTrue(x,d+1)});return w.or.some(function(x){return __whenTrue(x,d+1)})}
function __checkShortcut(s){
  if(typeof s.id!=='string'||!__shortcutName.test(s.id))return{ok:false,reason:'invalid-id',message:'A shortcut id is 1-64 letters, digits, "-" or "_", starting with a letter or digit.'};
  var k=s.keys;var mods=k&&k.modifiers;
  if(!k||typeof k!=='object'||typeof k.key!=='string'||!k.key.trim()||!Array.isArray(mods)||mods.some(function(m){return !__modifierNames[m]})||mods.filter(function(m,i){return mods.indexOf(m)===i}).length!==mods.length)return{ok:false,reason:'invalid-keys',message:'A shortcut needs a key and distinct modifiers from cmd, ctrl, shift and alt.'};
  if(s.when!==undefined&&!__whenValid(s.when,0))return{ok:false,reason:'invalid-when',message:'"'+JSON.stringify(s.when)+'" is neither a host context key nor a valid scope name.'};
  var hit=__reservedChords[__chord(k)];
  if(hit)return{ok:false,reason:'reserved',message:hit.indexOf('editing.')===0?'This chord is reserved for text editing (copy, paste, cut, undo, redo, select all).':"This chord belongs to Station's "+'"'+hit+'"'+" shortcut, which plugins cannot override."};
  return{ok:true,registryId:'plugin.dev.'+s.id};
}
var __editable='input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]';
function __ignored(e,k){if(e.defaultPrevented||__modalOpen())return true;var t=e.target&&e.target.matches?e.target:null;var m=k.modifiers;if(String(k.key).toLowerCase()==='escape')return !!(t&&(t.matches(__editable)||t.closest('[data-escape-owner]')))||!!document.querySelector('[data-escape-owner]');if(m.indexOf('cmd')>=0||m.indexOf('ctrl')>=0||m.indexOf('alt')>=0)return false;return !!(t&&t.matches(__editable))}
function __matches(e,k){var m=k.modifiers;var cmd=m.indexOf('cmd')>=0,ctrl=m.indexOf('ctrl')>=0;return e.metaKey===(__isMac&&cmd)&&e.ctrlKey===(ctrl||(!__isMac&&cmd))&&e.shiftKey===(m.indexOf('shift')>=0)&&e.altKey===(m.indexOf('alt')>=0)&&String(e.key).toLowerCase()===String(k.key).toLowerCase()}
function __useShortcut(s){var R=window.React;var run=R.useRef(s.run);run.current=s.run;var res=__checkShortcut(s);var ok=res.ok,en=s.enabled!==false,keysKey=JSON.stringify(s.keys===undefined?null:s.keys),whenKey=JSON.stringify(s.when===undefined?null:s.when);
  R.useEffect(function(){if(!ok){console.warn('Station refused shortcut "'+s.id+'": '+res.message);return}if(!en)return;var k=JSON.parse(keysKey),w=JSON.parse(whenKey);function h(e){if(!__matches(e,k)||__ignored(e,k))return;if(w!==null&&!__whenTrue(w,0))return;if(run.current()!==false)e.preventDefault()}window.addEventListener('keydown',h);return function(){window.removeEventListener('keydown',h)}},[ok,en,keysKey,whenKey]);
  return res}
function __useShortcutScope(name,active){var R=window.React;if(typeof name!=='string'||!__shortcutName.test(name)||__hostKeys[name])throw new Error('"'+name+'" is not a valid shortcut scope name (1-64 letters, digits, "-" or "_", and not a host context key).');var on=active!==false;
  R.useLayoutEffect(function(){if(!on)return;__scopes[name]=(__scopes[name]||0)+1;return function(){__scopes[name]-=1;if(__scopes[name]<=0)delete __scopes[name]}},[name,on])}
var __mobileQuery='(max-width: 768px), (max-height: 540px) and (pointer: coarse)';
function __readFacts(){return{device:{isMobile:!!(window.matchMedia&&window.matchMedia(__mobileQuery).matches)}}}
function __useHostFacts(){var R=window.React;var st=R.useState(__readFacts),f=st[0],set=st[1];R.useEffect(function(){if(!window.matchMedia)return;var mq=window.matchMedia(__mobileQuery);var h=function(){set(__readFacts())};mq.addEventListener('change',h);return function(){mq.removeEventListener('change',h)}},[]);return f}
var __nl=String.fromCharCode(10);
var __host={
  clipboard:{writeText:function(t){try{var c=navigator.clipboard;if(!c||typeof c.writeText!=='function')return Promise.resolve(false);return c.writeText(t).then(function(){return true},function(){return false})}catch(e){return Promise.resolve(false)}}},
  openExternal:function(url){var u=null;try{u=new URL(url)}catch(e){}if(!u||(u.protocol!=='http:'&&u.protocol!=='https:')){window.__devToast&&window.__devToast('Station only opens web (http or https) links: '+url);return Promise.resolve(false)}if(u.username||u.password){window.__devToast&&window.__devToast('Station does not open links that carry a user name or password.');return Promise.resolve(false)}window.open(u.href,'_blank','noopener,noreferrer');return Promise.resolve(true)},
  prompt:function(r){var v=window.prompt('From dev plugin: '+(r.title||'')+(r.label?__nl+r.label:''),r.initial||'');v=v==null?'':String(v).trim();return Promise.resolve(v?v:null)},
  confirm:function(r){return Promise.resolve(window.confirm('From dev plugin: '+(r.title||'')+__nl+(r.message||''))?'confirmed':'cancelled')}
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
  useShortcutScope:__useShortcutScope,
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
