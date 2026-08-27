import {
  type AgentDelegationPolicy,
  delegationDeniedCommandCatalog,
} from '@kontourai/station-contracts/agent';

/** Read-only projection of the restrictions enforced for delegated children. */
export function AgentDelegationDenialCatalog({
  delegation,
}: {
  delegation?: AgentDelegationPolicy;
}) {
  const catalog = delegationDeniedCommandCatalog(delegation?.blockedTools);

  return (
    <section className="agent-editor__section" aria-labelledby="ae-denials">
      {/* Collapsed by default: ten built-in denial rows dominated the
          creation form (owner dogfood report) while being read-only
          reference material nobody needs mid-create. */}
      <details className="agent-editor__denials-disclosure">
        <summary>
          <h4 id="ae-denials" className="agent-editor__section-title">
            Delegated-child denials
            {` (${catalog.builtIn.length} built-in${catalog.operatorConfigured.length > 0 ? `, ${catalog.operatorConfigured.length} configured` : ''})`}
          </h4>
        </summary>
        <p className="agent-editor__section-desc">
          These commands are refused before a delegated child can use them.
          Built-in denials cannot be removed.
        </p>
        <div className="editor-field">
          <span className="editor-label">Built-in denials</span>
          <ul>
            {catalog.builtIn.map((denial) => (
              <li key={denial.pattern}>
                <code>{denial.pattern}</code> — {denial.refusal}
              </li>
            ))}
          </ul>
        </div>
        <div className="editor-field">
          <span className="editor-label">Operator-configured denials</span>
          {catalog.operatorConfigured.length > 0 ? (
            <ul>
              {catalog.operatorConfigured.map((denial) => (
                <li key={denial.pattern}>
                  <code>{denial.pattern}</code> — {denial.refusal}
                </li>
              ))}
            </ul>
          ) : (
            <span className="editor-hint">None configured for this Agent.</span>
          )}
        </div>
      </details>
    </section>
  );
}
