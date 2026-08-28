import { useState } from 'react';
import { Button } from '../components/Button';
import { CheckboxGlyph } from '../components/Checkbox';
import { Dialog } from '../components/Dialog';
import { SkeletonList } from '../components/state';
import type { Tool } from '../types';

interface AgentAddModalProps {
  type: 'integrations' | 'skills';
  availableTools: Tool[];
  availableSkills: any[];
  form: {
    tools: { mcpServers: string[]; available: string[] };
    skills: string[];
  };
  setForm: React.Dispatch<React.SetStateAction<any>>;
  onClose: () => void;
  isLoading?: boolean;
}

export function AgentAddModal({
  type,
  availableTools,
  availableSkills,
  form,
  setForm,
  onClose,
  isLoading,
}: AgentAddModalProps) {
  const [search, setSearch] = useState('');
  const q = search.toLowerCase();
  const noun = type === 'integrations' ? 'Integrations' : 'Skills';

  // CAT-R06: every row rendered `<button onClick=toggle><Checkbox/></button>`,
  // and `Checkbox` is a `<label>` around a real input. A `<label>` inside a
  // `<button>` is invalid interactive nesting — the label click activated the
  // input, which synthesised a second click that bubbled to the button, so the
  // toggle fired twice and netted to zero. Clicking the tick box literally did
  // nothing; only the row's text worked. The row is the control now: it draws
  // the state with `CheckboxGlyph` and announces it with `aria-pressed`.
  //
  // Was a hand-rolled overlay with `responsive-surface-*` classes pasted on:
  // it looked like a dialog and behaved like a div — no focus containment, no
  // Escape, no focus restoration, and its own header/footer/button chrome.
  // On the shared `Dialog` it gets the lifecycle and the one chrome (SHELL-02).
  return (
    <Dialog
      title={`Add ${noun}`}
      closeLabel="Close add items"
      onClose={onClose}
      size="lg"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="editor-add-modal__body">
        <input
          type="text"
          className="editor-input editor-add-modal__search"
          placeholder={`Search ${noun.toLowerCase()}...`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {isLoading && (
          <SkeletonList count={4} label={`Loading ${noun.toLowerCase()}`} />
        )}
        {type === 'integrations' &&
          availableTools
            .filter(
              (t) =>
                !q ||
                (t.displayName || t.id).toLowerCase().includes(q) ||
                t.description?.toLowerCase().includes(q),
            )
            .map((integration) => {
              const enabled = form.tools.mcpServers.includes(integration.id);
              return (
                <button
                  type="button"
                  key={integration.id}
                  className={`editor__tool-item${enabled ? ' editor__tool-item--active' : ''}`}
                  aria-pressed={enabled}
                  onClick={() => {
                    setForm((f: any) => {
                      const servers = new Set(f.tools.mcpServers);
                      const avail = [...f.tools.available];
                      if (servers.has(integration.id)) {
                        servers.delete(integration.id);
                        return {
                          ...f,
                          tools: {
                            ...f.tools,
                            mcpServers: [...servers],
                            available: avail.filter(
                              (p: string) =>
                                !p.startsWith(`${integration.id}_`),
                            ),
                          },
                        };
                      }
                      servers.add(integration.id);
                      avail.push(`${integration.id}_*`);
                      return {
                        ...f,
                        tools: {
                          ...f.tools,
                          mcpServers: [...servers],
                          available: avail,
                        },
                      };
                    });
                  }}
                >
                  <CheckboxGlyph checked={enabled} />
                  <div className="editor__tool-info">
                    <div className="editor__tool-name">
                      {integration.displayName || integration.id}
                    </div>
                    {integration.description && (
                      <div className="editor__tool-desc">
                        {integration.description}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
        {type === 'skills' &&
          availableSkills
            .filter(
              (s: any) =>
                !q ||
                s.name.toLowerCase().includes(q) ||
                s.description?.toLowerCase().includes(q),
            )
            .map((skill: any) => {
              const enabled = form.skills.includes(skill.name);
              return (
                <button
                  type="button"
                  key={skill.name}
                  className={`editor__tool-item${enabled ? ' editor__tool-item--active' : ''}`}
                  aria-pressed={enabled}
                  onClick={() => {
                    setForm((f: any) => ({
                      ...f,
                      skills: enabled
                        ? f.skills.filter((s: string) => s !== skill.name)
                        : [...f.skills, skill.name],
                    }));
                  }}
                >
                  <CheckboxGlyph checked={enabled} />
                  <div className="editor__tool-info">
                    <div className="editor__tool-name">{skill.name}</div>
                    {skill.description && (
                      <div className="editor__tool-desc">
                        {skill.description}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
      </div>
    </Dialog>
  );
}
