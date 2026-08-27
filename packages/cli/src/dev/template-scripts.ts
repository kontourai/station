export function buildThemeBootstrapScript(): string {
  return "document.documentElement.setAttribute('data-theme',localStorage.getItem('theme')||'dark');";
}

export function buildDevSharedRuntimeScript(sdkMockJs: string): string {
  return `
${sdkMockJs}
var __sdkMock = window.__station_ai_sdk_mock;
window.__station_ai_shared = {
  'react': window.React,
  'react/jsx-runtime': window.__jsx,
  'react/jsx-dev-runtime': window.__jsxDev,
  'react-dom': window.ReactDOM,
  'react-dom/client': window.ReactDOM,
  '@tanstack/react-query': window.__station_ai_rq,
  '@kontourai/station-sdk': Object.assign({}, __sdkMock, {default:__sdkMock, __esModule:true}),
  '@kontourai/station-components': new Proxy({}, {get: function() { return function() { return null; }; }}),
  'dompurify': {sanitize:function(s){return s},default:{sanitize:function(s){return s}}},
  'debug': function(){return function(){}},
  'zod': window.__station_ai_zod
};
// The host defers some shared modules and exposes this handle as the contract
// for page-level callers (station#883). The harness resolves everything up
// front, so readiness is already satisfied — but the function must EXIST, or
// a plugin following the documented \`await window.__station_ai_shared_ready()\`
// throws here while working against the real host.
window.__station_ai_shared_ready = function(){return Promise.resolve()};
window.require=function(m){if(window.__station_ai_shared&&window.__station_ai_shared[m])return window.__station_ai_shared[m];throw new Error('require not available: '+m)};`;
}

export interface DevAppScriptOptions {
  pluginName: string;
  tabsJson: string;
  registryJson: string;
}

export function buildDevAppScript({
  pluginName,
  tabsJson,
  registryJson,
}: DevAppScriptOptions): string {
  return `
(function(){
  function noop(){}
  var plugin=window.__station_ai_plugins&&window.__station_ai_plugins['${pluginName}'];
  if(!plugin){document.getElementById('root').innerHTML='<div class="dev-error">Plugin failed to load. Check console.</div>';return}
  var React=window.React,ReactDOM=window.ReactDOM,RQ=window.__station_ai_rq;
  var tabs=${tabsJson};
  var registry=${registryJson};
  var bc=document.getElementById('dev-breadcrumb');

  class EB extends React.Component{
    constructor(p){super(p);this.state={e:null}}
    static getDerivedStateFromError(e){return{e:e}}
    render(){return this.state.e?React.createElement('div',{className:'dev-error'},React.createElement('strong',null,'Error: '),this.state.e.message,React.createElement('pre',{style:{fontSize:12,marginTop:8,color:'var(--text-muted)'}},this.state.e.stack)):this.props.children}
  }

  function h(t,p){var a=Array.prototype.slice.call(arguments,2);return React.createElement.apply(React,[t,p].concat(a))}

  function DetailRow(props){
    var ref=React.useState(false),open=ref[0],setOpen=ref[1];
    return h('div',{className:'info-item'+(open?' info-item--open':''),onClick:function(){setOpen(!open)}},
      h('div',{className:'info-item-header'},
        h('span',{className:'info-item-icon'},props.icon),
        h('span',{className:'info-item-name'},props.name),
        props.badge&&h('span',{className:'info-item-badge'},props.badge),
        h('span',{className:'info-item-chevron'},open?'▾':'▸')
      ),
      open&&h('div',{className:'info-item-detail'},
        props.children
      )
    );
  }

  function KV(props){
    var val=props.href
      ?h('a',{className:'info-kv-val info-kv-link',href:props.href,target:'_blank',rel:'noopener noreferrer',onClick:function(e){e.stopPropagation()}},props.v)
      :h('span',{className:'info-kv-val'},props.v);
    return h('div',{className:'info-kv'},h('span',{className:'info-kv-key'},props.k),val);
  }

  function SourceLink(props){
    if(!props.path)return null;
    var href='/api/open-file?path='+encodeURIComponent(props.path);
    return h('div',{className:'info-kv'},h('span',{className:'info-kv-key'},'source'),h('a',{className:'info-kv-val info-kv-link',href:href,onClick:function(e){e.stopPropagation()}},props.path));
  }

  function gitToHttps(src){
    if(!src)return null;
    var m=src.match(/^git@([^:]+):(.+?)(\\.git)?$/);
    return m?'https://'+m[1].replace(/^ssh\\./,'')+'/'+m[2]:src.match(/^https?:/)?src:null;
  }

  function Section(props){
    return h('div',{className:'info-section'},
      h('div',{className:'info-section-header'},
        h('span',{className:'info-section-title'},props.title),
        h('span',{className:'info-section-count'},String(props.items?props.items.length:0))
      ),
      (!props.items||!props.items.length)
        ?h('div',{className:'info-empty'},'none registered')
        :props.items.map(props.render)
    );
  }

  function CardItem(props){
    var ref=React.useState(false),open=ref[0],setOpen=ref[1];
    var pills=props.pills||[];
    return h('div',{className:'info-card'+(open?' info-item--open':''),onClick:function(e){e.stopPropagation();setOpen(!open)}},
      h('div',{className:'info-card-top'},
        h('span',{className:'info-card-icon'},props.icon),
        h('span',{className:'info-card-name'},props.name),
        props.badge&&h('span',{className:'info-card-badge'},props.badge)
      ),
      props.sub&&h('div',{className:'info-card-sub'},props.sub),
      pills.length>0&&h('div',{style:{marginTop:4,display:'flex',flexWrap:'wrap',gap:3}},
        pills.map(function(u,i){
          return h('span',{key:i,style:{fontSize:10,padding:'1px 6px',borderRadius:3,background:'rgba(34,197,94,0.15)',color:'var(--accent-acp)',fontFamily:'SF Mono,Menlo,monospace'}},u.scope+' \\u2192 '+u.label);
        })
      ),
      open&&h('div',{className:'info-card-detail'},props.children)
    );
  }

  function InfoPage(){
    bc.textContent='';
    var reg=registry;
    var promptMap={};
    (reg.prompts||[]).forEach(function(p){promptMap[p.id]=p});
    var promptUsage={};
    (reg.actions||[]).forEach(function(a){
      if(a.type==='prompt'){var pid=a.data.split(':').pop();if(!promptUsage[pid])promptUsage[pid]=[];promptUsage[pid].push({label:a.label,scope:'global'})}
    });
    var allTabs=(reg.layouts&&reg.layouts[0]&&Array.isArray(reg.layouts[0].tabs))?reg.layouts[0].tabs:[];
    allTabs.forEach(function(tab){
      (tab.actions||[]).forEach(function(a){
        var pid=(a.data||a.id||'').split(':').pop();if(!promptUsage[pid])promptUsage[pid]=[];promptUsage[pid].push({label:a.label||a.id,scope:tab.label||tab.id});
      });
    });
    return h('div',{className:'info-wrap'},
      h('div',{className:'info-top-row'},
        h('div',{className:'info-top-col'},
          h(Section,{title:'LAYOUTS',items:reg.layouts,render:function(l){
            var tabList=Array.isArray(l.tabs)?l.tabs:[];
            var tabCount=tabList.length;
            return h('div',{key:l.slug},
              h('a',{className:'info-layout-card',href:'#/layout/'+l.slug},
                l.icon&&h('div',{className:'info-layout-icon'},l.icon),
                h('div',{className:'info-layout-body'},
                  h('div',{className:'info-layout-name'},l.name),
                  h('div',{className:'info-layout-meta'},tabCount+' tabs')
                ),
                h('span',{className:'info-layout-arrow'},'→')
              ),
              tabList.length>0&&h('div',{style:{marginTop:6,marginBottom:12}},tabList.map(function(tab){
                var actions=tab.actions||[];
                return h('div',{key:tab.id,style:{padding:'10px 14px',marginBottom:4,background:'var(--bg-secondary)',border:'1px solid var(--border-primary)',borderRadius:6}},
                  h('div',{style:{display:'flex',alignItems:'center',gap:8}},
                    tab.icon&&h('span',null,tab.icon),
                    h('span',{style:{fontWeight:500,fontSize:13}},tab.label),
                    h('span',{className:'info-card-badge'},tab.component)
                  ),
                  actions.length>0&&h('div',{style:{marginTop:8,paddingTop:8,borderTop:'1px solid var(--border-primary)'}},
                    actions.map(function(a,i){
                      return h('div',{key:i,className:'info-action-card',style:{marginBottom:4}},
                        a.icon&&h('span',{className:'info-action-icon'},a.icon),
                        h('div',{className:'info-action-body'},
                          h('div',{className:'info-action-name'},a.label||a.id),
                          h('div',{className:'info-action-meta'},a.id||'')
                        ),
                        h('span',{className:'info-action-badge'},'tab action')
                      );
                    })
                  )
                );
              }))
            );
          }})
        ),
        h('div',{className:'info-top-col'},
          h(Section,{title:'ACTIONS',items:reg.actions,render:function(a,i){
            return h('div',{key:i,className:'info-action-card'},
              a.icon&&h('span',{className:'info-action-icon'},a.icon),
              h('div',{className:'info-action-body'},
                h('div',{className:'info-action-name'},a.label),
                h('div',{className:'info-action-meta'},a.type==='external'?h('a',{className:'info-kv-link',href:a.data,target:'_blank',rel:'noopener noreferrer'},a.data):a.data)
              ),
              h('span',{className:'info-action-badge'},a.type)
            );
          }})
        )
      ),
      h(Section,{title:'AGENTS',items:reg.agents,render:function(a){
        return h(CardItem,{key:a.slug,icon:a.icon||'',name:a.name,badge:a.model?a.model.split('.').pop():'',sub:a.slug+(a.mcpServers&&a.mcpServers.length?' · '+a.mcpServers.join(', '):'')},
          a.model&&h(KV,{k:'model',v:a.model}),
          a.guardrails&&h(KV,{k:'maxTokens',v:String(a.guardrails.maxTokens||'')}),
          a.guardrails&&h(KV,{k:'temperature',v:String(a.guardrails.temperature||'')}),
          a.prompt&&h('pre',{className:'info-prompt-pre',style:{margin:'4px 0 8px'}},a.prompt),
          h(SourceLink,{path:a._source})
        );
      }}),
      h('div',{className:'info-top-row'},
        h('div',{className:'info-top-col'},
          h(Section,{title:'INTEGRATIONS',items:reg.integrations,render:function(ig){
            var cmd=ig.command+(ig.args&&ig.args.length?' '+ig.args.join(' '):'');
            return h(CardItem,{key:ig.id,icon:ig.icon||'',name:ig.displayName||ig.id,badge:ig.id,sub:cmd},
              ig.description&&h(KV,{k:'description',v:ig.description}),
              ig.kind&&h(KV,{k:'kind',v:ig.kind}),
              ig.transport&&h(KV,{k:'transport',v:ig.transport}),
              ig.permissions&&h(KV,{k:'permissions',v:JSON.stringify(ig.permissions)}),
              h(SourceLink,{path:ig._source})
            );
          }})
        ),
        h('div',{className:'info-top-col'},
          h(Section,{title:'PROMPTS',items:reg.prompts,render:function(p){
            var usage=promptUsage[p.id]||[];
            return h(CardItem,{key:p.id,icon:p.icon||'',name:p.name,badge:p.requires?p.requires.join(', '):'',sub:p.id,pills:usage},
              p.content&&h('pre',{className:'info-prompt-pre',style:{margin:'4px 0 8px'}},p.content),
              h(SourceLink,{path:p._source})
            );
          }})
        )
      ),
      h(Section,{title:'DEPENDENCIES',items:reg.dependencies,render:function(d){
        var href=gitToHttps(d.source);
        var hasDetail=reg.depRegistries&&reg.depRegistries[d.id];
        return h('a',{key:d.id,className:'info-layout-card',href:hasDetail?'#/dep/'+d.id:(href||'#'),target:hasDetail?undefined:'_blank',rel:hasDetail?undefined:'noopener noreferrer',style:{textDecoration:'none'}},
          h('div',{className:'info-layout-body'},
            h('div',{className:'info-layout-name'},d.id),
            h('div',{className:'info-layout-meta'},d.source||'local')
          ),
          hasDetail&&h('span',{className:'info-layout-arrow'},'→')
        );
      }})
    );
  }

  var __sdkComponents = window.__station_sdk || {};
  var SDKProvider = __sdkComponents.SDKProvider;
  var LayoutHeader = __sdkComponents.LayoutHeader;
  var __devSDKContext = {
    apiBase: '',
    contexts: {
      navigation: { useNavigation: __sdkMock.useNavigation },
      auth: { useAuth: __sdkMock.useAuth },
      toast: { useToast: __sdkMock.useToast },
    },
    hooks: {}
  };

  function LayoutView(props){
    var slug=props.slug;
    var layout=registry.layouts&&registry.layouts.find(function(l){return l.slug===slug});
    var layoutName=layout?layout.name:slug;
    bc.innerHTML='<span class="dev-banner-sep"> › </span><span class="dev-banner-crumb">'+layoutName+'</span>';
    var ref=React.useState(tabs[0]?tabs[0].id:null),activeTab=ref[0],setActiveTab=ref[1];
    window.__devSetTab=setActiveTab;
    var comps=plugin.components||{};
    var td=tabs.find(function(t){return t.id===activeTab});
    var C=td?comps[td.component]:null;
    var globalActions=registry.actions||[];
    var tabActions=(td&&td.actions)||[];

    function handleAction(a){
      if(a.type==='external'){window.open(a.data,'_blank');return}
      window.__devToast('Prompt: '+(a.label||a.data||'action'));
    }

    return React.createElement(React.Fragment,null,
      h(LayoutHeader,{
        layoutName:layoutName,
        tabs:tabs.map(function(t){return{id:t.id,label:t.label,icon:t.icon}}),
        activeTabId:activeTab,
        onTabChange:setActiveTab,
        actions:globalActions,
        onLaunchAction:handleAction,
        title:td?td.label:layoutName,
        description:td?td.description||'':'',
        tabActions:tabActions,
        onTabPromptSelect:handleAction
      }),
      h('div',{className:'dev-tab-content'},
        C?h(EB,{key:activeTab},h(C,{onShowChat:noop}))
         :h('div',{style:{padding:'2rem',color:'var(--text-muted)'}},'No component: '+(td?td.component:activeTab))
      )
    );
  }

  function getRoute(){
    var hash=location.hash.replace(/^#/,'');
    var m=hash.match(new RegExp('^/layout/(.+)$'));
    if(m)return{view:'layout',slug:m[1]};
    var d=hash.match(new RegExp('^/dep/(.+)$'));
    if(d)return{view:'dep',depId:d[1]};
    return{view:'info'};
  }

  function DepPage(props){
    var depId=props.depId;
    var depReg=registry.depRegistries&&registry.depRegistries[depId];
    var depName=depReg?depReg.name:depId;
    bc.innerHTML='<span class="dev-banner-sep"> › </span><span class="dev-banner-crumb">'+depName+'</span>';
    if(!depReg)return h('div',{className:'info-wrap'},h('div',{className:'dev-error'},'No data found for dependency: '+depId));
    return h('div',{className:'info-wrap'},
      h('div',{className:'info-top-row'},
        h('div',{className:'info-top-col'},
          h(Section,{title:'LAYOUTS',items:depReg.layouts,render:function(l){
            var tabList=Array.isArray(l.tabs)?l.tabs:[];
            return h('div',{key:l.slug},
              h('div',{className:'info-layout-card'},
                l.icon&&h('div',{className:'info-layout-icon'},l.icon),
                h('div',{className:'info-layout-body'},
                  h('div',{className:'info-layout-name'},l.name),
                  h('div',{className:'info-layout-meta'},tabList.length+' tabs')
                )
              ),
              tabList.length>0&&h('div',{style:{marginTop:6,marginBottom:12}},tabList.map(function(tab){
                return h('div',{key:tab.id,style:{padding:'10px 14px',marginBottom:4,background:'var(--bg-secondary)',border:'1px solid var(--border-primary)',borderRadius:6}},
                  h('div',{style:{display:'flex',alignItems:'center',gap:8}},
                    tab.icon&&h('span',null,tab.icon),
                    h('span',{style:{fontWeight:500,fontSize:13}},tab.label),
                    h('span',{className:'info-card-badge'},tab.component)
                  )
                );
              }))
            );
          }})
        ),
        h('div',{className:'info-top-col'},
          h(Section,{title:'ACTIONS',items:depReg.actions,render:function(a,i){
            return h('div',{key:i,className:'info-action-card'},
              a.icon&&h('span',{className:'info-action-icon'},a.icon),
              h('div',{className:'info-action-body'},
                h('div',{className:'info-action-name'},a.label),
                h('div',{className:'info-action-meta'},a.data||'')
              ),
              h('span',{className:'info-action-badge'},a.type)
            );
          }})
        )
      ),
      h(Section,{title:'AGENTS',items:depReg.agents,render:function(a){
        return h(CardItem,{key:a.slug,icon:'',name:a.name,badge:a.model?a.model.split('.').pop():'',sub:a.slug+(a.mcpServers&&a.mcpServers.length?' · '+a.mcpServers.join(', '):'')},
          a.model&&h(KV,{k:'model',v:a.model}),
          a.prompt&&h('pre',{className:'info-prompt-pre',style:{margin:'4px 0 8px'}},a.prompt),
          h(SourceLink,{path:a._source})
        );
      }}),
      h('div',{className:'info-top-row'},
        h('div',{className:'info-top-col'},
          h(Section,{title:'INTEGRATIONS',items:depReg.integrations,render:function(ig){
            var cmd=ig.command+(ig.args&&ig.args.length?' '+ig.args.join(' '):'');
            return h(CardItem,{key:ig.id,icon:'',name:ig.displayName||ig.id,badge:ig.id,sub:cmd},
              ig.description&&h(KV,{k:'description',v:ig.description}),
              h(SourceLink,{path:ig._source})
            );
          }})
        ),
        h('div',{className:'info-top-col'},
          h(Section,{title:'PROMPTS',items:depReg.prompts,render:function(p){
            return h(CardItem,{key:p.id,icon:p.icon||'',name:p.name,badge:'',sub:p.id},
              p.content&&h('pre',{className:'info-prompt-pre',style:{margin:'4px 0 8px'}},p.content),
              h(SourceLink,{path:p._source})
            );
          }})
        )
      ),
      depReg.providers&&depReg.providers.length>0&&h(Section,{title:'PROVIDERS',items:depReg.providers,render:function(p,i){
        return h(CardItem,{key:i,icon:'',name:p.type,badge:'provider',sub:h('a',{className:'info-kv-link',href:'/api/open-file?path='+encodeURIComponent(p._source||p.module),onClick:function(e){e.stopPropagation()}},p.module)});
      }}),
      h(Section,{title:'DEPENDENCIES',items:depReg.dependencies,render:function(d){
        return h('div',{key:d.id,className:'info-action-card'},
          h('div',{className:'info-action-body'},
            h('div',{className:'info-action-name'},d.id),
            h('div',{className:'info-action-meta'},d.source||'local')
          )
        );
      }})
    );
  }

  function DevShell(){
    var ref=React.useState(getRoute),route=ref[0],setRoute=ref[1];
    window.__devShowInfo=function(){location.hash='#/'};
    React.useEffect(function(){
      function onHash(){setRoute(getRoute())}
      window.addEventListener('hashchange',onHash);
      return function(){window.removeEventListener('hashchange',onHash)};
    },[]);
    var inner=route.view==='layout'
      ?h(LayoutView,{slug:route.slug})
      :route.view==='dep'
      ?h(DepPage,{depId:route.depId})
      :h(InfoPage,null);
    return RQ&&RQ.QueryClientProvider
      ?h(RQ.QueryClientProvider,{client:window.__devQC||(window.__devQC=new RQ.QueryClient())},inner)
      :inner;
  }

  ReactDOM.createRoot(document.getElementById('root')).render(
    h(SDKProvider,{value:__devSDKContext},h(DevShell,null))
  );
})();`;
}

export function buildReloadScript(): string {
  return "(function(){var es=new EventSource('/api/reload');es.onmessage=function(e){if(e.data==='reload')location.reload()}})()";
}
