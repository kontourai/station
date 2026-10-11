import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  receiverBuildInputs,
  receiverBuildProvenance,
  writeReceiverArtifactManifest,
} from './artifact-manifest.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = await realpath(join(root, '../..'));
const outdir = join(root, 'dist');
const provenance = await receiverBuildProvenance(repoRoot);
const inputs = receiverBuildInputs(repoRoot);
for (const file of [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'packages/telemetry-broker/build.mjs',
  'packages/telemetry-broker/artifact-manifest.mjs',
])
  await inputs.capture(join(repoRoot, file));
const result = await build({
  absWorkingDir: repoRoot,
  entryPoints: {
    main: join(root, 'src/main.ts'),
    index: join(root, 'src/index.ts'),
  },
  outdir,
  write: false,
  plugins: [inputs.plugin],
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
await mkdir(outdir, { recursive: true });
await writeReceiverArtifactManifest(
  repoRoot,
  outdir,
  result.outputFiles,
  inputs.records(),
  provenance,
);
