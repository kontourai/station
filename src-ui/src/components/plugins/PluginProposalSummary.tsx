import type { PluginLifecycleProposalAuthor } from '@kontourai/station-contracts/plugin';
import {
  describeProposalAuthor,
  describeProposalSource,
  quoteProposalRationale,
  stripFormatCharacters,
} from '../../utils/pluginProposal';
import './PluginProposalSummary.css';

/**
 * Who proposed a plugin change, what it names, and the agent's own words
 * (#2323 S5). One rendering for the inbox row and the Plugins dialogs, so a
 * person reads the same facts wherever they decide.
 *
 * A git source shows its host and its repository path on separate lines: a
 * lookalike path ("github.com/…" inside another host's path) is easy to miss
 * in one string and hard to miss when the host stands alone.
 */
export function PluginProposalSummary({
  author,
  source,
  pluginName,
  rationale,
  testId = 'plugin-proposal-summary',
}: {
  author: PluginLifecycleProposalAuthor;
  source?: string;
  pluginName?: string;
  rationale?: string;
  testId?: string;
}) {
  const parts = source ? describeProposalSource(source) : null;
  return (
    <div className="plugin-proposal-summary" data-testid={testId}>
      <div data-testid={`${testId}-author`}>
        {describeProposalAuthor(author)}
      </div>
      {parts?.kind === 'git' && (
        <dl className="plugin-proposal-summary__source">
          <dt>Host</dt>
          <dd data-testid={`${testId}-host`}>{parts.host}</dd>
          <dt>Repository path</dt>
          <dd data-testid={`${testId}-path`}>{parts.path}</dd>
        </dl>
      )}
      {parts?.kind === 'local' && (
        <dl className="plugin-proposal-summary__source">
          <dt>Local folder</dt>
          <dd data-testid={`${testId}-path`}>{parts.path}</dd>
        </dl>
      )}
      {parts?.kind === 'other' && (
        <dl className="plugin-proposal-summary__source">
          <dt>Source</dt>
          <dd data-testid={`${testId}-path`}>{parts.text}</dd>
        </dl>
      )}
      {pluginName && (
        <dl className="plugin-proposal-summary__source">
          <dt>Plugin</dt>
          <dd>{stripFormatCharacters(pluginName)}</dd>
        </dl>
      )}
      {rationale && (
        <blockquote
          className="plugin-proposal-summary__rationale"
          data-testid={`${testId}-rationale`}
        >
          {quoteProposalRationale(rationale)}
        </blockquote>
      )}
    </div>
  );
}
