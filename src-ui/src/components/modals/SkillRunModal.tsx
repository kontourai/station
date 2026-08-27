import { useEffect, useMemo, useState } from 'react';
import {
  type SubstitutableSkillVariable,
  substituteSkillVariables,
} from '../../utils/skill-commands';
import {
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../ResponsiveDialogSurface';
import './SkillRunModal.css';

interface SkillRunModalProps {
  isOpen: boolean;
  skill: { name: string; body: string };
  /** Full declared variables (name + default), not bare names: the preview
   * applies defaults, and substitution is the shared derivation. */
  variables: SubstitutableSkillVariable[];
  agents: { slug: string; name: string }[];
  onRun: (resolvedContent: string, agentSlug: string) => void;
  onCancel: () => void;
}

export function SkillRunModal({
  isOpen,
  skill,
  variables,
  agents,
  onRun,
  onCancel,
}: SkillRunModalProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const defaultAgentSlug = agents[0]?.slug || '';
  const [agentSlug, setAgentSlug] = useState(defaultAgentSlug);

  // Entered values belong to THIS test of THIS skill: closing the modal or
  // switching skills discards them (review M3 — they used to survive both).
  // `defaultAgentSlug` is a string, so the effect re-runs only when the
  // default actually changes, not on a parent re-render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: skill.name is the intentional reset signal (same idiom as ProviderSettingsView's selection reset).
  useEffect(() => {
    if (isOpen) {
      setValues({});
      setAgentSlug(defaultAgentSlug);
    }
  }, [isOpen, skill.name, defaultAgentSlug]);

  // The SAME substitution the slash handler runs: declared defaults apply, a
  // variable with neither a value nor a default is rejected and named — the
  // preview never silently shows an empty gap where one belonged.
  const substitution = useMemo(
    () => substituteSkillVariables(skill.body, variables, values),
    [skill.body, variables, values],
  );
  const resolved = substitution.ok ? substitution.content : null;

  if (!isOpen) return null;

  return (
    <ResponsiveDialogSurface
      onClose={onCancel}
      ariaLabelledBy="skill-run-modal-title"
      overlayClassName="modal-overlay"
      panelClassName="modal-dialog skill-run__dialog"
    >
      <div className="modal-header">
        <h3 id="skill-run-modal-title">Test: {skill.name}</h3>
      </div>
      <div className="modal-body">
        {variables.length > 0 && (
          <>
            <div className="skill-run__section-label">Variables</div>
            <div className="skill-run__var-grid">
              {variables.map((v) => (
                <div key={v.name} className="editor-field">
                  <label
                    className="editor-label"
                    htmlFor={`skill-variable-${v.name}`}
                  >
                    {`{{${v.name}}}`}
                  </label>
                  <input
                    id={`skill-variable-${v.name}`}
                    className="editor-input"
                    // The placeholder IS the value a cleared field will use
                    // (delta review): clearing a field falls back to its
                    // declared default, so the preview and this hint agree.
                    placeholder={
                      v.default !== undefined ? `default: ${v.default}` : v.name
                    }
                    value={values[v.name] || ''}
                    onChange={(e) =>
                      setValues((prev) => ({
                        ...prev,
                        [v.name]: e.target.value,
                      }))
                    }
                  />
                </div>
              ))}
            </div>
          </>
        )}

        <div className="skill-run__section-label">Preview</div>
        {resolved !== null ? (
          <div className="skill-run__preview">{resolved}</div>
        ) : (
          <p role="alert" className="skill-run__error">
            Needs a value for{' '}
            {substitution.ok
              ? null
              : substitution.missing.map((name) => (
                  <code key={name}>{`{{${name}}}`}</code>
                ))}
          </p>
        )}

        <div className="editor-field skill-run__agent-field">
          <label className="editor-label" htmlFor="skill-run-agent">
            Agent
          </label>
          <select
            id="skill-run-agent"
            className="editor-select"
            value={agentSlug}
            onChange={(e) => setAgentSlug(e.target.value)}
          >
            <option value="">— select agent —</option>
            {agents.map((a) => (
              <option key={a.slug} value={a.slug}>
                {a.name || a.slug}
              </option>
            ))}
          </select>
        </div>
      </div>
      <ResponsiveSurfaceActions className="modal-footer">
        <button type="button" className="editor-btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="editor-btn editor-btn--primary"
          disabled={!agentSlug || resolved === null}
          onClick={() => resolved !== null && onRun(resolved, agentSlug)}
        >
          ▶ Send to Agent
        </button>
      </ResponsiveSurfaceActions>
    </ResponsiveDialogSurface>
  );
}
