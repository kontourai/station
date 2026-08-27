import {
  buildDevAppScript,
  buildDevSharedRuntimeScript,
  buildReloadScript,
  buildThemeBootstrapScript,
} from './template-scripts.js';
import { DEV_TEMPLATE_STYLES } from './template-styles.js';

export interface DevTemplateOptions {
  name: string;
  pluginName: string;
  tabsJson: string;
  registryJson: string;
  sdkMockJs: string;
}

/** Generate the dev preview HTML page */
export function generateDevHTML(opts: DevTemplateOptions): string {
  const { name, pluginName, tabsJson, registryJson, sdkMockJs } = opts;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${name} — Dev Preview</title>
<link rel="stylesheet" href="/bundle.css">
<link rel="stylesheet" href="/sdk-dev.css">
<style>
${DEV_TEMPLATE_STYLES}
</style>
<script>${buildThemeBootstrapScript()}</script>
</head><body>
<div class="dev-banner">
  <div class="dev-banner-left">
    <span class="dev-banner-name" onclick="location.hash='#/'">${name}</span>
    <span id="dev-breadcrumb"></span>
  </div>
  <button class="dev-theme-btn" onclick="var t=document.documentElement.getAttribute('data-theme')==='light'?'dark':'light';document.documentElement.setAttribute('data-theme',t);localStorage.setItem('theme',t);this.textContent=t==='dark'?'☀️':'🌙'">☀️</button>
</div>
<div id="root"></div>
<script src="/react-dev.js"></script>
<script>${buildDevSharedRuntimeScript(sdkMockJs)}</script>
<script src="/sdk-dev.js"></script>
<script src="/bundle.js"></script>
<script>${buildDevAppScript({ pluginName, tabsJson, registryJson })}</script>
<script>${buildReloadScript()}</script>
</body></html>`;
}
