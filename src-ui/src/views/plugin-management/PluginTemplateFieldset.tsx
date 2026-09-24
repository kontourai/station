import type { PluginScaffoldTemplateChoice } from './plugin-scaffold-client';

const TEMPLATE_CHOICES: {
  value: PluginScaffoldTemplateChoice;
  label: string;
  description: string;
}[] = [
  {
    value: 'pane',
    label: 'Pane',
    description: 'One Workspace Pane with a stylesheet. The usual start.',
  },
  {
    value: 'full',
    label: 'Pane and Agent',
    description: 'Two Panes and an Agent definition.',
  },
  {
    value: 'provider',
    label: 'Server provider',
    description:
      'A server module and a branding provider. Installing it needs trusted permissions.',
  },
];

/** The scaffold template choice, shared by both "start a plugin" entry points. */
export function PluginTemplateFieldset({
  name,
  value,
  onChange,
}: {
  /** The radio group name; unique per form. */
  name: string;
  value: PluginScaffoldTemplateChoice;
  onChange: (value: PluginScaffoldTemplateChoice) => void;
}) {
  return (
    <fieldset className="plugins__new-plugin-templates">
      <legend className="editor-label">Start from</legend>
      {TEMPLATE_CHOICES.map((choice) => (
        <label key={choice.value} className="plugins__new-plugin-template">
          <input
            type="radio"
            name={name}
            value={choice.value}
            checked={value === choice.value}
            onChange={() => onChange(choice.value)}
          />
          <span>
            <strong>{choice.label}</strong>
            <span className="plugins__install-hint">{choice.description}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
