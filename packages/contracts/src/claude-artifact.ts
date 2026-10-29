/**
 * A Claude Code Artifact publish as a reader links to it: the page Claude
 * published on claude.ai and its title.
 *
 * Claude Code's `Artifact` tool publishes a local HTML or Markdown file as a
 * page on claude.ai. The engine reports the outcome twice: as text for the
 * model, and as the tool's structured output (the Agent SDK's
 * `tool_use_result`, typed `ArtifactOutput` in `sdk-tools.d.ts`). Only the
 * structured output is read here; the URL is never scraped from text.
 *
 * Of `ArtifactOutput`'s variants, only a publish carries `url` and `path` at
 * its top level (`list`, `read`, `watch` and the rest nest their URLs). A
 * link is admitted only when its URL parses as https on exactly `claude.ai`,
 * with no credentials or port, so a transcript never offers a lookalike or
 * non-web link under an artifact label.
 */

/** The Claude Code tool that publishes artifacts. */
export const CLAUDE_ARTIFACT_TOOL_NAME = 'Artifact';
/** Longest artifact URL admitted; a longer one is refused, not cut. */
export const CLAUDE_ARTIFACT_URL_MAX_CHARS = 2048;
/** Longest title kept; a longer one is dropped and the URL labels the link. */
export const CLAUDE_ARTIFACT_TITLE_MAX_CHARS = 200;

const CLAUDE_ARTIFACT_HOST = 'claude.ai';

export interface ClaudeArtifactLink {
  /** The parsed, normalized https://claude.ai URL of the published page. */
  readonly url: string;
  readonly title?: string;
}

/**
 * `value` as a normalized artifact URL, or `undefined` unless it parses as
 * `https://claude.ai/...` with no user name, password or port.
 */
export function claudeArtifactUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > CLAUDE_ARTIFACT_URL_MAX_CHARS)
    return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== CLAUDE_ARTIFACT_HOST ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  )
    return undefined;
  return parsed.href;
}

function artifactTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value.trim();
  if (!title || title.length > CLAUDE_ARTIFACT_TITLE_MAX_CHARS)
    return undefined;
  return title;
}

function linkFrom(
  url: unknown,
  title: unknown,
): ClaudeArtifactLink | undefined {
  const href = claudeArtifactUrl(url);
  if (!href) return undefined;
  const text = artifactTitle(title);
  return text ? { url: href, title: text } : { url: href };
}

/**
 * The link a publish produced, read from the `Artifact` tool's structured
 * output; `undefined` for any other action's output or an inadmissible URL.
 */
export function parseClaudeArtifactPublish(
  output: unknown,
): ClaudeArtifactLink | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output))
    return undefined;
  const record = output as Record<string, unknown>;
  if (typeof record.path !== 'string') return undefined;
  return linkFrom(record.url, record.title);
}

/**
 * A stored or streamed {@link ClaudeArtifactLink}, checked again before a
 * reader renders it as a link; `undefined` when it does not hold.
 */
export function claudeArtifactLinkView(
  value: unknown,
): ClaudeArtifactLink | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  return linkFrom(record.url, record.title);
}
