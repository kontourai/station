import { useState } from 'react';
import { AgentIcon } from '../../components/icons/AgentIcon';
import type { AgentEditorFormProps } from './types';
import { slugify } from './utils';

export function AgentEditorIdentityFields({
  form,
  setForm,
  isCreating,
  locked,
  validationErrors,
}: Pick<
  AgentEditorFormProps,
  'form' | 'setForm' | 'isCreating' | 'locked' | 'validationErrors'
>) {
  const [editingSlug, setEditingSlug] = useState(false);

  return (
    <>
      <div className="editor-field">
        <label className="editor-label" htmlFor="ae-name">
          Name <span className="editor-required">*</span>
          <span className="editor-hint"> · {form.slug}</span>
          {isCreating && (
            <button
              type="button"
              className="editor-enrich-btn"
              aria-expanded={editingSlug}
              aria-controls="ae-slug"
              disabled={locked}
              onClick={() => setEditingSlug((current) => !current)}
            >
              Edit
            </button>
          )}
        </label>
        <input
          id="ae-name"
          type="text"
          className="editor-input"
          name="name"
          value={form.name}
          onChange={(event) => {
            const name = event.target.value;
            setForm((current) => ({
              ...current,
              name,
              slug: isCreating ? slugify(name) : current.slug,
            }));
          }}
          placeholder="My Agent"
          disabled={locked}
        />
        {validationErrors.name && (
          <span className="editor-error">{validationErrors.name}</span>
        )}
        {isCreating && editingSlug && (
          <input
            id="ae-slug"
            type="text"
            className="editor-input"
            name="slug"
            aria-label="Slug"
            value={form.slug}
            onChange={(event) =>
              isCreating &&
              setForm((current) => ({ ...current, slug: event.target.value }))
            }
            disabled={false}
            placeholder="my-agent"
          />
        )}
        {validationErrors.slug && (
          <span className="editor-error">{validationErrors.slug}</span>
        )}
      </div>

      <div className="editor-field">
        <label className="editor-label" htmlFor="ae-icon">
          Icon
        </label>
        <div className="editor-icon-row">
          <AgentIcon
            agent={{ name: form.name || 'Agent', icon: form.icon }}
            size="large"
            className="editor-icon-preview"
          />
          <input
            id="ae-icon"
            type="text"
            className="editor-input"
            name="icon"
            value={form.icon}
            onChange={(event) =>
              setForm((current) => ({ ...current, icon: event.target.value }))
            }
            placeholder="Icon or leave empty for initials"
            disabled={locked}
          />
        </div>
      </div>

      <div className="editor-field">
        <label className="editor-label" htmlFor="ae-description">
          Description
        </label>
        <input
          id="ae-description"
          type="text"
          className="editor-input"
          name="description"
          value={form.description}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              description: event.target.value,
            }))
          }
          placeholder="A helpful agent for..."
          disabled={locked}
        />
      </div>
    </>
  );
}
