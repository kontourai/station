import type { ComposerToken } from './composer-mentions';

export function ComposerMentionChips({
  value,
  onChange,
  onFocusInput,
  tokens,
}: {
  value: string;
  onChange: (value: string) => void;
  onFocusInput: () => void;
  tokens: ComposerToken[];
}) {
  return (
    <ul className="composer-mentions" aria-label="Composer references">
      {tokens.map((token) => {
        const mention = 'path' in token;
        const kind = mention ? 'mention' : 'reference';
        return (
          <li key={`${kind}:${token.canonicalStart}`}>
            <button
              type="button"
              className="composer-mentions__chip"
              title={mention ? token.path : token.label}
              aria-label={
                mention
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
                {!mention ? '↗' : token.type === 'directory' ? '▸' : '@'}
              </span>
              {token.label}
              <span aria-hidden="true">×</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
