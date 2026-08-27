import type { ReactNode } from 'react';
import { BrandIcon } from '../../components/icons/BrandIcon';
import { connectionTypeLabel } from '../../utils/execution';
import { MODEL_PROVIDER_CHOICES } from './providerCatalog';
import type { ProviderConnection } from './types';

function ProviderOverviewSection({
  title,
  emptyText,
  providers,
  onSelect,
  icon,
}: {
  title: string;
  emptyText: string;
  providers: ProviderConnection[];
  onSelect: (id: string) => void;
  icon: ReactNode;
}) {
  return (
    <div
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        borderRadius: '8px',
        padding: '16px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '10px',
          color: 'var(--text-muted)',
        }}
      >
        {icon}
        <span
          style={{
            fontSize: '11px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          {title}
        </span>
      </div>
      {providers.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {providers.map((provider) => (
            <button
              type="button"
              key={provider.id}
              className="provider-overview__card-item"
              onClick={() => onSelect(provider.id)}
            >
              <span className="provider-overview__dot provider-overview__dot--active" />
              <span
                style={{
                  fontSize: '13px',
                  fontWeight: 500,
                  color: 'var(--text-primary)',
                }}
              >
                {provider.name}
              </span>
              <span
                style={{
                  fontSize: '11px',
                  color: 'var(--text-muted)',
                  marginLeft: 'auto',
                }}
              >
                {connectionTypeLabel(provider.type)}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p
          style={{
            fontSize: '13px',
            color: 'var(--text-muted)',
            margin: 0,
          }}
        >
          {emptyText}
        </p>
      )}
    </div>
  );
}

export function ProviderStackOverview({
  providers,
  onSelect,
  onAdd,
}: {
  providers: ProviderConnection[];
  onSelect: (id: string) => void;
  onAdd: (type: string, name: string, config?: Record<string, string>) => void;
}) {
  const llmProviders = providers.filter(
    (provider) => provider.enabled && provider.capabilities.includes('llm'),
  );
  const embeddingProviders = providers.filter(
    (provider) =>
      provider.enabled && provider.capabilities.includes('embedding'),
  );

  return (
    <div className="provider-overview">
      <div className="provider-overview__header">
        <h3 className="provider-overview__title">Station model connections</h3>
        <p className="provider-overview__desc">
          Connections used by Station's engine. Engine connections appear in
          Connections.
        </p>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          marginBottom: '24px',
        }}
      >
        <ProviderOverviewSection
          title="LLM"
          emptyText="No language model connection configured"
          providers={llmProviders}
          onSelect={onSelect}
          icon={
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          }
        />
        <ProviderOverviewSection
          title="Embedding"
          emptyText="No embedding connection — required for knowledge search"
          providers={embeddingProviders}
          onSelect={onSelect}
          icon={
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
          }
        />
      </div>

      {providers.length === 0 && (
        <div className="provider-overview__quickstart">
          <h4 className="provider-overview__quickstart-title">Quick Setup</h4>
          <p className="provider-overview__quickstart-desc">
            Add a model connection to get started
          </p>
          <div className="provider-overview__quickstart-options">
            {MODEL_PROVIDER_CHOICES.map((option) => (
              <button
                type="button"
                key={option.id}
                className="provider-overview__quickstart-btn"
                onClick={() => onAdd(option.type, option.name, option.config)}
              >
                <span className="provider-overview__quickstart-icon">
                  <BrandIcon
                    name={option.name}
                    id={option.id}
                    identiconSeed={`provider:${option.id}`}
                    size={22}
                  />
                </span>
                <div>
                  <div className="provider-overview__quickstart-name">
                    {option.name}
                  </div>
                  <div className="provider-overview__quickstart-meta">
                    {option.desc}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
