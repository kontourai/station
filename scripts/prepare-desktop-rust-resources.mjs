import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { stageDesktopNodeRuntime } from './lib/desktop-node-runtime.mjs';

const root = process.cwd();
const runtime = resolve(root, 'dist-desktop-runtime');
for (const path of ['dist-server', 'node_modules', 'examples']) {
  mkdirSync(resolve(runtime, path), { recursive: true });
}
await stageDesktopNodeRuntime(root, runtime);
