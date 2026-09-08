import { readFileSync } from 'node:fs';
import {
  buildPlugin,
  readPluginBuildManifest,
} from '@kontourai/station-shared/build';
import { INVOKED_CWD } from './helpers.js';

export async function build(
  mode: 'production' | 'dev' = 'production',
): Promise<void> {
  const manifest = readPluginBuildManifest(INVOKED_CWD);
  console.log(
    `📦 Building ${manifest.displayName || manifest.name}${mode === 'dev' ? ' (dev)' : ''}...`,
  );
  const result = await buildPlugin(INVOKED_CWD, mode);
  if (result.built && result.bundlePath) {
    const size = readFileSync(result.bundlePath).length;
    const cssSize = result.cssPath ? readFileSync(result.cssPath).length : 0;
    console.log(
      `✅ ${result.bundlePath.replace(`${INVOKED_CWD}/`, '')} (${(size / 1024).toFixed(1)}KB)${cssSize ? ` + css (${(cssSize / 1024).toFixed(1)}KB)` : ''}`,
    );
  }
}
