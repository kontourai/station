import { Badge, type SemanticTone } from '@kontourai/ui/react';
import {
  MCP_AUTH_MODE_LABELS,
  MCP_QUALIFICATION_LABELS,
  type RegistryItem,
} from './registryCatalogModel';

type McpServerListing = NonNullable<RegistryItem['mcpServer']>;

const QUALIFICATION_TONES: Record<
  McpServerListing['qualification']['state'],
  SemanticTone
> = {
  qualified: 'positive',
  'setup-required': 'caution',
  blocked: 'caution',
  unqualified: 'neutral',
};

/** What Station checked, never what the source claims about itself. */
export function McpQualificationBadge({
  listing,
}: {
  listing: McpServerListing;
}) {
  return (
    <Badge
      value={MCP_QUALIFICATION_LABELS[listing.qualification.state]}
      tone={QUALIFICATION_TONES[listing.qualification.state]}
    />
  );
}

/** What Station knows about one MCP subregistry entry, before any effect. */
export function RegistryMcpServerFacts({
  listing,
  installed,
}: {
  listing: McpServerListing;
  installed: boolean;
}) {
  const checkedOn = listing.qualification.checkedAt?.slice(0, 10);
  return (
    <div className="registry-mcp" data-testid="registry-mcp-facts">
      <div className="page__meta-row">
        <McpQualificationBadge listing={listing} />
        <Badge value={MCP_AUTH_MODE_LABELS[listing.authMode]} tone="neutral" />
        {listing.launchStage && (
          <Badge
            value={
              listing.launchStage === 'developer-preview'
                ? 'Developer Preview'
                : 'Preview'
            }
            tone="caution"
          />
        )}
        {listing.contentTrust === 'untrusted' && (
          <Badge value="Untrusted content" tone="caution" />
        )}
      </div>
      {listing.contentTrust === 'untrusted' && (
        <p className="page__subtitle">
          In Station-engine sessions, asks before tools that send or change
          things by default. You can change this.
        </p>
      )}
      {listing.unavailable.length > 0 ? (
        <ul
          className="registry-mcp__unavailable"
          aria-label="Why it cannot be added"
        >
          {listing.unavailable.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : (
        !installed && (
          <p className="page__subtitle">
            {listing.qualification.state === 'setup-required'
              ? 'Adds it turned off. Enter your OAuth client in its settings, then sign in.'
              : 'Adds it turned off. Turn it on and sign in under Connections.'}
          </p>
        )
      )}
      <details>
        <summary>Details</summary>
        <dl className="registry-mcp__facts">
          <dt>Server</dt>
          <dd>
            <code>{listing.name}</code> v{listing.version}
          </dd>
          {listing.remote && (
            <>
              <dt>Endpoint</dt>
              <dd>
                <code className="registry-catalog__source">
                  {listing.remote.url}
                </code>
              </dd>
            </>
          )}
          <dt>Checked</dt>
          <dd>{checkedOn ?? 'Not checked by Station'}</dd>
        </dl>
        {listing.qualification.summary && (
          <p className="page__subtitle">{listing.qualification.summary}</p>
        )}
      </details>
    </div>
  );
}
