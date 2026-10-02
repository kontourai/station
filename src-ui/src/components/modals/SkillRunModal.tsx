import type { SkillVariable } from '@kontourai/station-contracts/catalog';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { substituteSkillVariables } from '../../utils/skill-commands';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import './SkillRunModal.css';

interface SkillRunModalProps {
  isOpen: boolean;
  skill: { name: string; body: string };
  /** Full declared variables (name + default), not bare names: the preview
   * applies defaults, and substitution is the shared derivation. */
  variables: SkillVariable[];
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

  // Entered values belong to THIS use of THIS skill: closing the modal or
  // switching skills discards them (review — they used to survive both).
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

  // #1180: opened from the skill action inside `SkillsView`'s skill detail — the
  // content `SplitPaneLayout` portals into `PageFrame`'s mobile-detail slot
  // on a phone, and therefore exempt from the `inert` that slot's sibling
  // frame div carries while the sheet is open (PageFrame.tsx:155). Rendered
  // in place, THIS modal was not that exempt content — it is a plain sibling
  // of `SplitPaneLayout`, so it inherited the `inert` its own trigger button
  // was exempt from: visible, but `.focus()` a no-op and every button
  // unclickable. `createPortal` to `document.body` is the same escape
  // `ConfirmModal` and `PluginModalStack` (#1131) already use, for the same
  // reason — DOM placement only, so React context and event bubbling still
  // follow the component tree.
  return createPortal(
    <Dialog
      title={`Use: ${skill.name}`}
      subtitle="Review the inputs and choose an agent to start a new chat with these instructions."
      closeLabel="Close use skill"
      onClose={onCancel}
      size="lg"
      panelClassName="skill-run__dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={
              !agents.some((agent) => agent.slug === agentSlug) ||
              resolved === null
            }
            onClick={() => resolved !== null && onRun(resolved, agentSlug)}
          >
            Start chat
          </Button>
        </>
      }
    >
      {variables.length > 0 && (
        <>
          <div className="skill-run__section-label">Your inputs</div>
          <div className="skill-run__var-grid">
            {variables.map((v) => (
              <div key={v.name} className="editor-field">
                <label
                  className="editor-label"
                  htmlFor={`skill-variable-${v.name}`}
                >
                  {v.name}
                </label>
                <p
                  className="skill-run__input-hint"
                  id={`skill-variable-hint-${v.name}`}
                >
                  {v.description && <span>{v.description} </span>}
                  {v.default?.trim()
                    ? 'Optional; leave blank to use the default.'
                    : 'Required.'}
                </p>
                <input
                  aria-describedby={`skill-variable-hint-${v.name}`}
                  id={`skill-variable-${v.name}`}
                  className="editor-input"
                  // The placeholder IS the value a cleared field will use
                  // clearing a field falls back to its
                  // declared default, so the preview and this hint agree.
                  placeholder={
                    v.default?.trim() ? `default: ${v.default}` : v.name
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

      {resolved === null && !substitution.ok && (
        <p role="alert" className="skill-run__error">
          Needs a value for{' '}
          {substitution.missing.map((name) => (
            <code key={name}>{`{{${name}}}`}</code>
          ))}
        </p>
      )}
      {resolved !== null && (
        <details
          className="skill-run__instructions"
          open={variables.length === 0}
        >
          <summary>Preview instructions</summary>
          <div className="skill-run__preview">{resolved}</div>
        </details>
      )}
      {agents.length === 0 && (
        <p className="skill-run__input-hint">
          No agents are available. Add or configure an agent before starting a
          chat.
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
    </Dialog>,
    document.body,
  );
}
