import { createSkillExperiencePaneHost } from '@kontourai/station-sdk/workspace-pane';

function javascriptStringLiteral(value: string): string {
  return JSON.stringify(value).replace(
    /[<>\u2028\u2029]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function buildPluginFrameRuntime(
  origin: string,
  pluginName: string,
): string {
  return `window.__stationCreateSkillExperiencePaneHost=${createSkillExperiencePaneHost.toString()};window.__stationPaneHostOrigin=${javascriptStringLiteral(origin)};addEventListener('load',()=>queueMicrotask(()=>parent.postMessage({method:'initialize',params:{exports:Object.keys(window.__station_ai_plugins?.[${javascriptStringLiteral(pluginName)}]?.components||{})}},'*')));`;
}
