import type { ClaudeArtifactLink } from '@kontourai/station-contracts/claude-artifact';
import type { MouseEvent } from 'react';
import {
  displayedExternalLink,
  hostOwnsExternalLinks,
  openNativeExternalLink,
} from '../../platform/openExternalLink';
import { ExternalLinkGlyph } from '../icons/Glyph';
import './ClaudeArtifactCard.css';

/**
 * A Claude Code Artifact publish as the transcript shows it: the page's
 * title and its claude.ai address, opened outside Station. On the web the
 * anchor opens a new tab with no opener; in the app the native host opens it
 * (and reports a refusal), as chat links do.
 */
export function ClaudeArtifactCard({ link }: { link: ClaudeArtifactLink }) {
  const shownUrl = displayedExternalLink(link.url);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!hostOwnsExternalLinks()) return;
    event.preventDefault();
    void openNativeExternalLink(link.url);
  };
  return (
    <div className="claude-artifact-card">
      <span className="claude-artifact-card__kind">Published artifact</span>
      <a
        className="claude-artifact-card__link"
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onClick}
        title={link.url}
      >
        <span className="claude-artifact-card__title">
          {link.title ?? shownUrl}
        </span>
        <span className="claude-artifact-card__url">
          {link.title ? shownUrl : 'claude.ai'}
        </span>
        <ExternalLinkGlyph className="claude-artifact-card__icon" />
      </a>
    </div>
  );
}
