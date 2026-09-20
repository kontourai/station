import {
  parseComposerMentions,
  parseComposerSessionReferences,
} from './composer-mentions';

export function ComposerMentionChips({
  value,
  onChange,
  onFocusInput,
}: {
  value: string;
  onChange: (value: string) => void;
  onFocusInput: () => void;
}) {
  const mentions = parseComposerMentions(value);
  const references = parseComposerSessionReferences(value);
  const tokens = [
    ...mentions.map((mention) => ({
      kind: 'mention' as const,
      token: mention,
    })),
    ...references.map((reference) => ({
      kind: 'reference' as const,
      token: reference,
    })),
  ].sort((a, b) => a.token.canonicalStart - b.token.canonicalStart);
  return (
    <ul className="composer-mentions" aria-label="Composer references">
      {tokens.map(({ kind, token }) => (
        <li key={`${kind}:${token.canonicalStart}`}>
          <button
            type="button"
            className="composer-mentions__chip"
            title={kind === 'mention' ? token.path : token.label}
            aria-label={
              kind === 'mention'
                ? `Remove ${token.type} mention ${token.path}`
                : `Remove conversation reference ${token.label}`
            }
            onClick={() => {
              onChange(
                `${value.slice(0, token.canonicalStart)}${value.slice(token.canonicalEnd)}`,
              );
              onFocusInput();
            }}
          >
            <span aria-hidden="true">
              {kind === 'reference'
                ? '↗'
                : token.type === 'directory'
                  ? '▸'
                  : '@'}
            </span>
            {token.label}
            <span aria-hidden="true">×</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
