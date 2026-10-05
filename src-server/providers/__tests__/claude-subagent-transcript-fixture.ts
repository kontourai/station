import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * #3163: a scrubbed Claude Code 2.1.283 subagent transcript (the outer agent
 * of the `nested-agent` capture: same Claude session and agent id), laid out
 * the way Claude Code writes it under a config home:
 * `projects/<project>/<session>.jsonl` and
 * `projects/<project>/<session>/subagents/agent-<id>.jsonl` (+ `.meta.json`).
 * The record shapes are copied from a real transcript with content scrubbed.
 */
export const TRANSCRIPT_SESSION_ID = '00000000-0000-4000-8000-000000000003';
export const TRANSCRIPT_AGENT_ID = 'a3849bb64b339db79';

const FIXTURE_DIR = fileURLToPath(
  new URL('./fixtures/claude-2.1.283-subagent-transcript/', import.meta.url),
);

/**
 * Installs the transcript under a fresh `CLAUDE_CONFIG_DIR` (the SDK reads
 * it per call) and returns a function restoring the variable. The directory
 * comes from the caller's `trackTempDirs()` tracker, which removes it.
 */
export function installClaudeSubagentTranscript(
  makeTempDir: (prefix: string) => string,
  options: {
    withAgent?: boolean;
    /** Leave CLAUDE_CONFIG_DIR alone: the directory is a session's own profile. */
    asProfile?: boolean;
  } = {},
): { configDir: string; restore: () => void } {
  const configDir = makeTempDir('station-claude-config-');
  const project = join(configDir, 'projects', '-workspace-example');
  const subagents = join(project, TRANSCRIPT_SESSION_ID, 'subagents');
  mkdirSync(subagents, { recursive: true });
  copyFileSync(
    join(FIXTURE_DIR, 'session.jsonl'),
    join(project, `${TRANSCRIPT_SESSION_ID}.jsonl`),
  );
  if (options.withAgent !== false) {
    for (const suffix of ['.jsonl', '.meta.json']) {
      copyFileSync(
        join(FIXTURE_DIR, `agent-${TRANSCRIPT_AGENT_ID}${suffix}`),
        join(subagents, `agent-${TRANSCRIPT_AGENT_ID}${suffix}`),
      );
    }
  }
  if (options.asProfile) return { configDir, restore: () => {} };
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  return {
    configDir,
    restore: () => {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    },
  };
}
