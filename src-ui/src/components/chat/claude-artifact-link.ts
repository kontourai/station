import {
  CLAUDE_ARTIFACT_TOOL_NAME,
  type ClaudeArtifactLink,
  claudeArtifactLinkView,
} from '@kontourai/station-contracts/claude-artifact';

/** The fields of a transcript tool part this module reads. */
interface ArtifactPartLike {
  toolName?: string;
  name?: string;
  claudeArtifact?: unknown;
  state?: string;
  error?: unknown;
  isError?: boolean;
  cancelled?: boolean;
}

/**
 * The claude.ai page a settled, successful Claude Code `Artifact` publish
 * produced, checked again here because a stored part is input; `undefined`
 * for any other call, which then keeps the ordinary tool row.
 */
export function claudeArtifactLinkOf(
  part: ArtifactPartLike,
): ClaudeArtifactLink | undefined {
  if ((part.toolName ?? part.name) !== CLAUDE_ARTIFACT_TOOL_NAME)
    return undefined;
  if (
    part.isError === true ||
    part.cancelled === true ||
    part.state === 'error' ||
    part.state === 'cancelled' ||
    part.error
  )
    return undefined;
  return claudeArtifactLinkView(part.claudeArtifact);
}
