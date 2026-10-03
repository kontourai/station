import { resolve } from 'node:path';
import { stageBundledRegistry } from './lib/bundled-registry.mjs';
import {
  stageDesktopServerRuntime,
  WINDOWS_DESKTOP_RUNTIME_RESOURCE_DIR,
} from './lib/desktop-server-runtime.mjs';

const projectRoot = process.cwd();
const outputRoot = stageDesktopServerRuntime({
  projectRoot,
  ...(process.platform === 'win32'
    ? {
        windowsWixResourceRoot: resolve(
          projectRoot,
          WINDOWS_DESKTOP_RUNTIME_RESOURCE_DIR,
        ),
      }
    : {}),
});
stageBundledRegistry({ projectRoot, outputRoot });
console.log(`Staged desktop server runtime dependencies in ${outputRoot}`);
