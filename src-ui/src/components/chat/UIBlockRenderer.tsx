import type {
  UIBlock,
  UICodeBlock,
  UIFormBlock,
} from '@kontourai/station-contracts/ui-block';
import { Badge } from '@kontourai/ui/react';
import { useId, useMemo, useState } from 'react';
import { useSyntaxHighlighter } from '../../contexts/SyntaxHighlighterContext';
import { useUIBlockActions } from './UIBlockActionsContext';

interface UIBlockRendererProps {
  block: UIBlock;
}

/**
 * archive#1399, : shipped the
 * `attestationState` DATA with no reader anywhere in the product — nothing
 * in `UIBlockRenderer` inspected it, so a `'unattested'` block rendered
 * identically to an `'attested'` one and the state was invisible in
 * practice. This is the minimal visible treatment, reusing Console Kit's
 * own `Badge` primitive (`ProvenanceBadge.tsx`'s established pattern —
 * consumed, not reinvented) rather than building a new indicator: a
 * `caution`-tone badge on a claiming card/table block whenever its
 * (host-derived, never block-declared) state is `'unattested'`. A
 * `'decorative'` block — no data claim at all — renders nothing extra, the
 * same as before; there is nothing to mark unattested about prose.
 */
/**
 * archive#1399 fix, (independent review — the reviewer's
 * condition for accepting the host's upward correction): Console Kit's
 * `Badge` has no title/tooltip prop of its own (it forwards only `value`/
 * `tone`/`className`), so the precise meaning is carried on a wrapping
 * `<span title>` — a plain, standard HTML tooltip, not a new component API.
 */
const UNATTESTED_TOOLTIP =
  'Unattested: the host has not receipted a source declaration for this data — it is not verified against anything.';

function UnattestedBadge({ block }: { block: UIBlock }) {
  if (block.attestationState !== 'unattested') return null;
  return (
    <span title={UNATTESTED_TOOLTIP}>
      <Badge
        value="Unattested"
        tone="caution"
        className="ui-block__unattested-badge"
      />
    </span>
  );
}

/** Stable key for a form block — its id, or a derived fallback when absent. */
function formKey(block: UIFormBlock, fallback: string): string {
  return (
    block.id ||
    `${block.title || 'form'}:${block.fields.map((f) => f.name).join(',')}:${fallback}`
  );
}

/**
 * Renders a `form` UIBlock as host-owned controlled inputs. On submit the values
 * re-enter the conversation as a new user turn (via UIBlockActionsContext) — the
 * agent run has already ended, so this is a follow-up turn, not a pending-call
 * resolution. Safe by construction: no agent-supplied markup is executed.
 */
function UIFormBlockView({ block }: { block: UIFormBlock }) {
  const { submitForm, submittedBlockIds } = useUIBlockActions();
  const reactId = useId();
  const key = formKey(block, reactId);
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const initial: Record<string, string | boolean> = {};
    for (const f of block.fields) {
      initial[f.name] =
        f.type === 'checkbox'
          ? f.defaultValue === 'true'
          : (f.defaultValue ?? '');
    }
    return initial;
  });
  const [error, setError] = useState<string | null>(null);
  const locked = submittedBlockIds.has(key);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (locked) return;
    const missing = block.fields.find(
      (f) =>
        f.required &&
        (f.type === 'checkbox'
          ? values[f.name] !== true
          : String(values[f.name] ?? '').trim() === ''),
    );
    if (missing) {
      setError(`"${missing.label}" is required.`);
      return;
    }
    setError(null);
    submitForm({
      blockId: key,
      title: block.title,
      values: block.fields.map((f) => ({
        name: f.name,
        label: f.label,
        value: values[f.name] ?? (f.type === 'checkbox' ? false : ''),
      })),
    });
  };

  return (
    <form className="ui-block ui-block--form" onSubmit={handleSubmit}>
      {(block.title || block.description) && (
        <div className="ui-block__header">
          {block.title && <h4 className="ui-block__title">{block.title}</h4>}
          {block.description && (
            <p className="ui-block__caption">{block.description}</p>
          )}
        </div>
      )}
      <div className="ui-block__form-fields">
        {block.fields.map((field) => {
          const fieldId = `${reactId}-${field.name}`;
          if (field.type === 'checkbox') {
            return (
              <label key={field.name} className="ui-block__form-check">
                <input
                  type="checkbox"
                  id={fieldId}
                  checked={values[field.name] === true}
                  disabled={locked}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [field.name]: e.target.checked }))
                  }
                />
                <span>{field.label}</span>
              </label>
            );
          }
          return (
            <div key={field.name} className="ui-block__form-field">
              <label htmlFor={fieldId}>
                {field.label}
                {field.required && (
                  <span className="ui-block__form-required"> *</span>
                )}
              </label>
              {field.type === 'textarea' ? (
                <textarea
                  id={fieldId}
                  value={String(values[field.name] ?? '')}
                  placeholder={field.placeholder}
                  disabled={locked}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [field.name]: e.target.value }))
                  }
                />
              ) : field.type === 'select' ? (
                <select
                  id={fieldId}
                  value={String(values[field.name] ?? '')}
                  disabled={locked}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [field.name]: e.target.value }))
                  }
                >
                  <option value="">Select…</option>
                  {(field.options ?? []).map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  id={fieldId}
                  value={String(values[field.name] ?? '')}
                  placeholder={field.placeholder}
                  disabled={locked}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [field.name]: e.target.value }))
                  }
                />
              )}
            </div>
          );
        })}
      </div>
      {error && <p className="ui-block__form-error">{error}</p>}
      <div className="ui-block__form-actions">
        <button
          type="submit"
          className="ui-block__form-submit"
          disabled={locked}
        >
          {locked ? 'Submitted' : block.submitLabel || 'Submit'}
        </button>
      </div>
    </form>
  );
}

/**
 * Renders a `code` UIBlock as inert, syntax-highlighted text. The source is
 * NEVER executed — Shiki produces escaped HTML, and the no-highlighter fallback
 * renders the raw string as React text content (also escaped). This is the
 * chat-native lane's safe-by-construction posture: the agent supplies data,
 * Station owns the markup.
 */
function UICodeBlockView({ block }: { block: UICodeBlock }) {
  const highlighter = useSyntaxHighlighter();
  const html = useMemo(
    () =>
      highlighter.ready && block.language
        ? highlighter.highlight(block.code, block.language)
        : null,
    [highlighter, highlighter.ready, block.code, block.language],
  );

  return (
    <section className="ui-block ui-block--code">
      {(block.title || block.caption || block.language) && (
        <div className="ui-block__header ui-block__code-header">
          {block.title && <h4 className="ui-block__title">{block.title}</h4>}
          {block.caption && (
            <p className="ui-block__caption">{block.caption}</p>
          )}
          {block.language && (
            <span className="ui-block__code-lang">{block.language}</span>
          )}
        </div>
      )}
      {html ? (
        // Shiki output is escaped HTML; the code is rendered, never executed.
        <div
          className="ui-block__code-body"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="ui-block__code-body">
          <code>{block.code}</code>
        </pre>
      )}
    </section>
  );
}

export function UIBlockRenderer({ block }: UIBlockRendererProps) {
  if (block.type === 'code') {
    return <UICodeBlockView block={block} />;
  }

  if (block.type === 'form') {
    return <UIFormBlockView block={block} />;
  }

  if (block.type === 'card') {
    return (
      <section
        className={`ui-block ui-block--card ui-block--tone-${block.tone || 'default'}`}
      >
        {(block.title || block.attestationState === 'unattested') && (
          <div className="ui-block__header">
            {block.title && <h4 className="ui-block__title">{block.title}</h4>}
            <UnattestedBadge block={block} />
          </div>
        )}
        <p className="ui-block__body">{block.body}</p>
        {block.fields && block.fields.length > 0 && (
          <dl className="ui-block__fields">
            {block.fields.map((field) => (
              <div key={field.label} className="ui-block__field">
                <dt>{field.label}</dt>
                <dd>{field.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    );
  }

  if (block.type === 'table') {
    return (
      <section className="ui-block ui-block--table">
        {(block.title ||
          block.caption ||
          block.attestationState === 'unattested') && (
          <div className="ui-block__header">
            {block.title && <h4 className="ui-block__title">{block.title}</h4>}
            {block.caption && (
              <p className="ui-block__caption">{block.caption}</p>
            )}
            <UnattestedBadge block={block} />
          </div>
        )}
        <div className="ui-block__table-wrap">
          <table className="ui-block__table">
            <thead>
              <tr>
                {block.columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${block.id || block.title || 'table'}-${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${rowIndex}-${cellIndex}`}>
                      {cell == null ? '—' : String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  return null;
}
