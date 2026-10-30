import { useEffect, useState } from 'react';

export function parseScopes(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

const formatScopes = (scopes: readonly string[]) => scopes.join('\n');

/**
 * OAuth scopes as a wrapping, one-per-line list, so long scope URLs stay
 * readable on a phone. The typed text is kept while editing (re-deriving it
 * from the parsed list would swallow the space being typed); it is normalized
 * on blur.
 */
export function ScopesField({
  id,
  label,
  hint,
  scopes,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  scopes: readonly string[];
  disabled?: boolean;
  onChange: (scopes: string[]) => void;
}) {
  const [text, setText] = useState(() => formatScopes(scopes));
  // Follow a change that did not come from this field (a reload or reset).
  useEffect(() => {
    setText((current) =>
      parseScopes(current).join(' ') === scopes.join(' ')
        ? current
        : formatScopes(scopes),
    );
  }, [scopes]);
  return (
    <div className="editor-field">
      <label className="editor-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="editor-textarea"
        // Scope URLs wrap to about two lines at phone width; size for that
        // so every requested scope stays visible without scrolling the field.
        rows={Math.max(3, 2 * parseScopes(text).length)}
        autoComplete="off"
        spellCheck={false}
        placeholder="Server default"
        value={text}
        disabled={disabled}
        onChange={(event) => {
          setText(event.target.value);
          onChange(parseScopes(event.target.value));
        }}
        onBlur={() => setText(formatScopes(parseScopes(text)))}
      />
      <p className="editor-field-hint">{hint}</p>
    </div>
  );
}
