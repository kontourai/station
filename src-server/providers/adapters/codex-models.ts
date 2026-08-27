import type { ApprovalMode } from '@kontourai/station-contracts/provider';

export type CodexReasoningEffort = 'xhigh' | 'high' | 'medium' | 'low';

export interface CodexModelOptions {
  /** Provider-neutral composer key; reasoningEffort remains a prior alias. */
  effort?: CodexReasoningEffort;
  reasoningEffort?: CodexReasoningEffort;
  fastMode?: boolean;
  /** Session-level approval posture override (#727). See ApprovalMode. */
  approvalMode?: ApprovalMode;
}

/**
 * station#977 ("local default + defer to engine"): unlike Claude Code's
 * short aliases (`sonnet`/`opus`/`haiku`, `claude-models.ts`), Codex has no
 * stable, in-repo-verifiable "current default" model id — `codex --help`/
 * `codex exec --help` expose only a free-form `-m/--model` override, the
 * installed CLI's own config comments explicitly say to leave `model`
 * unset so Codex uses "its current built-in defaults", and this codebase
 * has never hardcoded a codex model id anywhere (only ever discovered
 * live via `CodexAdapter.listModelCatalog`). Hardcoding a guessed id here
 * risked shipping a stale/wrong default silently. Deliberately left unset:
 * `CodexAdapter.metadata.defaultModel` and `knownModels` are both absent.
 * Codex still gets the core station#977 fix (an explicit `--model=x` that
 * misses the live catalog is passed through to the engine instead of
 * being rejected) — it just doesn't get a Station-selected model when omitted
 * or built-in picker entries when the live catalog is empty. Accepted,
 * disclosed gap; revisit if/when Codex publishes a stable default model id
 * this repo can verify against.
 */
