/**
 * Disposable process for ONE plugin draft build (epic #2323 S3, review
 * round 3). See `plugin-draft-build-process.ts` for why builds run here.
 *
 * Protocol: the parent sends one `{ options }` message; this process builds,
 * replies with one `{ result }` message, and exits. It never outlives its
 * build: the parent kills its whole process group at the deadline, taking
 * the esbuild service it started (and any thread blocked in a read) with it.
 */
import {
  buildPluginDraft,
  type PluginDraftBuildOptions,
  type PluginDraftBuildResult,
} from '@kontourai/station-shared/build';

type Request = {
  options: Omit<PluginDraftBuildOptions, 'signal'>;
};

/**
 * The parent died or stopped (server crash, SIGKILL, shutdown) without
 * killing this build. Detached into its own session, this process would
 * otherwise outlive the server with its blocked esbuild service. The IPC
 * channel closing is the one signal that always arrives, so take down this
 * process's own group — it leads that group, so this reaches exactly itself
 * and the esbuild service it started, nothing else.
 */
process.once('disconnect', () => {
  if (process.platform !== 'win32') {
    try {
      process.kill(-process.pid, 'SIGKILL');
    } catch {
      // Fall through to exit.
    }
  }
  process.exit(1);
});

process.once('message', (message: Request) => {
  void buildPluginDraft(message.options)
    .then(
      (result): PluginDraftBuildResult => result,
      (): PluginDraftBuildResult => ({
        ok: false,
        diagnostics: [{ text: 'The draft build failed unexpectedly.' }],
      }),
    )
    .then((result) => {
      process.send?.({ result }, () => process.exit(0));
    });
});
