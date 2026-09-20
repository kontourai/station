import { parseComposerMentions } from './composer-mentions';

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
  return (
    <ul className="composer-mentions" aria-label="Mentioned files and folders">
      {mentions.map((mention) => (
        <li
          key={`${mention.workspace}:${mention.path}:${mention.canonicalStart}`}
        >
          <button
            type="button"
            className="composer-mentions__chip"
            title={mention.path}
            aria-label={`Remove ${mention.type} mention ${mention.path}`}
            onClick={() => {
              onChange(
                `${value.slice(0, mention.canonicalStart)}${value.slice(mention.canonicalEnd)}`,
              );
              onFocusInput();
            }}
          >
            <span aria-hidden="true">
              {mention.type === 'directory' ? '▸' : '@'}
            </span>
            {mention.label}
            <span aria-hidden="true">×</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
