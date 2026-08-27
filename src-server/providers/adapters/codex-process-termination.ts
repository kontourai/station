import { terminateProcessTree } from '../../services/infra/process-utils.js';
import type { CodexProcessLike } from './codex-adapter-types.js';

export async function terminateCodexProcess(
  processHandle: CodexProcessLike,
): Promise<void> {
  try {
    await terminateProcessTree(processHandle, {
      graceMs: 100,
      killConfirmMs: 1_000,
      processGroup: true,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Process tree did not confirm exit after SIGKILL.'
    ) {
      throw new Error('Codex process did not confirm exit after SIGKILL.', {
        cause: error,
      });
    }
    throw error;
  }
}
