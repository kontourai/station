/**
 * Stands in for the Station server in `plugin-draft-build-process.test.ts`:
 * starts ONE draft build in a disposable child and reports the child's pid to
 * the test, then waits. The test SIGKILLs this process by that recorded pid
 * and asserts the build child (and its esbuild service) do not outlive it.
 */
import { buildPluginDraftInChildProcess } from '../../plugin-draft-build-process.js';

process.once('message', (message: { pluginDir: string; outdir: string }) => {
  void buildPluginDraftInChildProcess(
    {
      pluginDir: message.pluginDir,
      outdir: message.outdir,
      registrationKey: 'parent:1',
      manifest: {
        name: 'proc',
        version: '1.0.0',
        entrypoint: './src/index.tsx',
      },
    },
    { onSpawn: (pid) => process.send?.({ childPid: pid }) },
  );
});
