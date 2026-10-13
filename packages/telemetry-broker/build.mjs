import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: {
    main: join(root, 'src/main.ts'),
    index: join(root, 'src/index.ts'),
  },
  outdir: join(root, 'dist'),
  outExtension: { '.js': '.mjs' },
  banner: {
    js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);",
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'bundle',
  external: ['pg-native'],
});
