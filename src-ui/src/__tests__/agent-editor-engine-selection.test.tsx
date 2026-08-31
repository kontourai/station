/** @vitest-environment jsdom */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { navigationStore } from '../contexts/navigation-store';
import { AgentEditorEngineSelection } from '../views/agent-editor/AgentEditorEngineSelection';
import {
  createEmptyAgentForm,
  formFromAgent,
} from '../views/agent-editor/agentsViewUtils';

/**
 * archive#3662: the engine picker is the surface that decides
 * how "runs on Station's own engine" is SPELLED in the form, and it used to
 * spell it as a managed-runtime connection id. That made the one shape a
 * Station-engine Agent is supposed to persist — no binding at all — render as
 * "Select a ready engine", and selecting Station wrote an id back.
 */
const MANAGED_CONNECTION = {
  id: 'bedrock-runtime',
  kind: 'agent',
  type: 'bedrock-runtime',
  name: 'Station Managed',
  enabled: true,
  status: 'ready',
  capabilities: ['agent-runtime'],
  config: { engineId: 'station' },
  prerequisites: [],
} as never;

const CODEX_CONNECTION = {
  id: 'codex',
  kind: 'agent',
  type: 'codex',
  name: 'Codex',
  enabled: true,
  status: 'ready',
  capabilities: ['agent-runtime'],
  config: { engineId: 'codex' },
  prerequisites: [],
} as never;

function markupFor(
  form: ReturnType<typeof createEmptyAgentForm>,
  engineKind: 'model' | 'cli' = 'model',
): string {
  return renderToStaticMarkup(
    createElement(AgentEditorEngineSelection, {
      form,
      setForm: () => {},
      locked: false,
      validationErrors: {},
      agentConnections: [MANAGED_CONNECTION, CODEX_CONNECTION],
      onSwitchTab: () => {},
      engineKind,
      onEngineKindChange: () => {},
      stationConnectionId: 'bedrock-runtime',
    } as never),
  );
}

// archive#3721 replaced the <select> with an engine-kind radio pair + a nested CLI
// list, and left this suite matching <option> markup that no longer exists —
// a pre-existing main red this branch fix-forwards (the fix-forward pins the
// CURRENT contract, not the retired select). archive#3662's invariant survives the
// refactor in a different shape and is still pinned below: the Station
// choice never renders a managed-runtime connection AS "Station".
describe('the engine picker: radio pair, with Station spelled as its own choice (#3662 via #3721)', () => {
  test('a custom Agent renders the two engine-kind radios', () => {
    const form = formFromAgent({
      slug: 'writer',
      name: 'Writer',
    } as never);
    expect(form.execution.agentConnectionId).toBe('');
    const markup = markupFor(form);
    expect(markup).toContain('Use a model connection');
    expect(markup).toContain('Use an installed agent CLI');
    // The model-connection choice describes Station's own engine, never a
    // managed-runtime id presented as "Station".
    expect(markup).toContain('Station’s own engine runs the agent');
    expect(markup).not.toContain('value="bedrock-runtime"');
  });

  test('an externally bound Agent renders ITS OWN connection checked in the CLI list', () => {
    const form = formFromAgent({
      slug: 'coder',
      name: 'Coder',
      execution: { agentConnectionId: 'codex' },
    } as never);
    const markup = markupFor(form, 'cli');
    // archive#3728: a bare any-input-checked regex would pass with
    // ANY row checked. Associate checkedness with the Codex row: the checked
    // input and the Codex label text must sit inside one label element.
    const rows = markup.split('<label');
    const checkedRows = rows.filter(
      (row) => row.includes('name="ae-cli-engine"') && row.includes('checked'),
    );
    expect(checkedRows).toHaveLength(1);
    expect(checkedRows[0]).toContain('Codex');
  });

  test('choosing the model radio binds the selectable Station-engine connection, and the CLI radio clears it (#3721 contract)', () => {
    // archive#3728: the earlier rewrite never invoked a handler, so
    // nothing pinned what the choices WRITE. archive#3721's engine-first contract:
    // the model radio binds `stationConnectionId` (the managed-runtime
    // connection Station's engine runs on) and the CLI radio binds '' until
    // a CLI is explicitly named. archive#3662's storage shape ("Station = no
    // connection") is superseded by that contract; its surviving half is
    // presentational — no managed-runtime id is ever PRESENTED as "Station"
    // and is pinned above.
    const form = formFromAgent({ slug: 'writer', name: 'Writer' } as never);
    const renderWithKind = (engineKind: 'model' | 'cli', writes: string[]) =>
      render(
        createElement(AgentEditorEngineSelection, {
          form,
          setForm: (
            updater: (current: unknown) => {
              execution: { agentConnectionId: string };
            },
          ) => {
            writes.push(updater(form).execution.agentConnectionId);
          },
          locked: false,
          validationErrors: {},
          agentConnections: [MANAGED_CONNECTION, CODEX_CONNECTION],
          onSwitchTab: () => {},
          engineKind,
          onEngineKindChange: () => {},
          stationConnectionId: 'bedrock-runtime',
        } as never),
      );

    // A checked radio's click fires no change event, so each direction is
    // driven from the OTHER kind.
    const modelWrites: string[] = [];
    const first = renderWithKind('cli', modelWrites);
    fireEvent.click(
      screen.getByRole('radio', { name: /Use a model connection/ }),
    );
    expect(modelWrites).toEqual(['bedrock-runtime']);
    first.unmount();

    const cliWrites: string[] = [];
    renderWithKind('model', cliWrites);
    fireEvent.click(
      screen.getByRole('radio', { name: /Use an installed agent CLI/ }),
    );
    // The CLI choice must NOT auto-bind a CLI — an explicit step by design.
    expect(cliWrites).toEqual(['']);
  });
});

/**
 * archive#3721 moved the engine question out of AgentEditorBasicTab's
 * `<select>` and into this component's radio cards. Three properties of the
 * retired picker were still only asserted by
 * `AgentEditorBasicTab.test.tsx` — against `<option>` markup that has not
 * existed since — so they are re-pinned here against the affordance that
 * replaced it, keeping their behavioural intent verbatim.
 */
describe('the CLI list carries the retired engine picker’s outstanding properties (#3721)', () => {
  const UNREADY_CLAUDE = {
    id: 'claude',
    kind: 'agent',
    type: 'claude',
    name: 'Claude Runtime',
    enabled: true,
    status: 'missing_prerequisites',
    capabilities: ['agent-runtime'],
    config: { engineId: 'claude' },
    prerequisites: [],
  } as never;

  function renderSelection(
    form: ReturnType<typeof createEmptyAgentForm>,
    options: {
      engineKind?: 'model' | 'cli';
      connections?: never[];
      setForm?: (updater: (current: never) => never) => void;
    } = {},
  ) {
    return render(
      createElement(AgentEditorEngineSelection, {
        form,
        setForm: options.setForm ?? (() => {}),
        locked: false,
        validationErrors: {},
        agentConnections: options.connections ?? [
          MANAGED_CONNECTION,
          CODEX_CONNECTION,
          UNREADY_CLAUDE,
        ],
        onSwitchTab: () => {},
        engineKind: options.engineKind ?? 'cli',
        onEngineKindChange: () => {},
        stationConnectionId: 'bedrock-runtime',
      } as never),
    );
  }

  test('the CLI list offers every enabled engine CLI and keeps a non-ready one present but unselectable, saying why', () => {
    // Intent, unchanged from the retired picker: an unready engine is
    // OFFERED and explains itself, rather than vanishing (which reads as
    // "not installed") or being silently selectable.
    renderSelection(formFromAgent({ slug: 'coder', name: 'Coder' } as never));

    const list = screen.getByRole('radiogroup', {
      name: 'Installed agent CLI',
    });
    // Station is not a peer entry in this list — it is the sibling
    // engine-kind radio — so the list is exactly the external engines.
    expect(
      within(list)
        .getAllByRole('radio')
        .map(
          (radio) =>
            radio.closest('label')?.querySelector('strong')?.textContent,
        ),
    ).toEqual(['Codex', 'Claude Runtime']);

    const codex = within(list).getByRole('radio', { name: /Codex/ });
    expect((codex as HTMLInputElement).disabled).toBe(false);
    const claude = within(list).getByRole('radio', { name: /Claude Runtime/ });
    expect((claude as HTMLInputElement).disabled).toBe(true);
    expect(claude.closest('label')?.textContent).toContain('Setup required');
  });

  test('choosing another CLI rewrites the engine binding and never touches authored prompt, skills, or tools', () => {
    const authored = {
      ...formFromAgent({
        slug: 'coder',
        name: 'Coder',
        prompt: 'Authored prompt content',
        skills: ['writing'],
        toolsConfig: {
          mcpServers: ['filesystem'],
          available: [],
          autoApprove: [],
        },
        execution: { agentConnectionId: 'claude' },
      } as never),
    };
    const writes: ReturnType<typeof formFromAgent>[] = [];
    renderSelection(authored, {
      setForm: (updater) =>
        writes.push(
          updater(authored as never) as ReturnType<typeof formFromAgent>,
        ),
    });

    fireEvent.click(screen.getByRole('radio', { name: /Codex/ }));

    expect(writes).toHaveLength(1);
    expect(writes[0].execution.agentConnectionId).toBe('codex');
    expect(writes[0].execution.modelConnectionId).toBe('');
    expect(writes[0].execution.runtimeOptions).toEqual({});
    expect(writes[0].prompt).toBe('Authored prompt content');
    expect(writes[0].skills).toEqual(['writing']);
    expect(writes[0].tools.mcpServers).toEqual(['filesystem']);
  });

  test('an agent bound to a connection that no longer exists is not silently remapped onto Station', () => {
    // The retired picker rendered a disabled "Unavailable" option for this.
    // The surviving invariant is the one that matters: a vanished binding
    // must not read as a choice the person never made.
    renderSelection(
      formFromAgent({
        slug: 'coder',
        name: 'Coder',
        execution: { agentConnectionId: 'opencode-runtime' },
      } as never),
    );

    const list = screen.getByRole('radiogroup', {
      name: 'Installed agent CLI',
    });
    expect(
      within(list)
        .getAllByRole('radio')
        .filter((radio) => (radio as HTMLInputElement).checked),
    ).toHaveLength(0);
    expect(
      (
        screen.getByRole('radio', {
          name: /Use a model connection/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
  });

  test('Set one up reaches Engines instead of encoding its query into a not-found path', () => {
    window.history.replaceState({}, '', '/agents/new');
    renderSelection(formFromAgent({ slug: 'coder', name: 'Coder' } as never), {
      connections: [MANAGED_CONNECTION] as never,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Set one up' }));

    expect(window.location.pathname + window.location.search).toBe(
      '/connections/engines',
    );
    expect(navigationStore.getSnapshot().pathname).toBe('/connections/engines');
  });
});

describe('the built-in Agent states its engine, it does not pick one (#3662 delta H3)', () => {
  const stationMarkup = () =>
    markupFor(formFromAgent({ slug: 'station', name: 'Station' } as never));

  test('no engine control is offered for the reserved identity', () => {
    // `AppConfig.builtinAgentEngineConnectionId` owns this identity's engine
    // and it is resolved per boot; the record never carries the result
    // (agent-engine-unification.md 7.1.1). A picker here would have written a
    // value no reader consults and the write boundary drops.
    const markup = stationMarkup();
    expect(markup).not.toContain('<select');
    expect(markup).not.toContain('id="ae-engine"');
  });

  test('it names the engine and where the choice actually lives', () => {
    const markup = stationMarkup();
    expect(markup).toContain('Station');
    expect(markup).toContain('Change it in Settings');
  });

  test('it names the external engine the runtime resolved', () => {
    // The catalog projects the runtime binding onto this identity, so the
    // form receives it — and must report it rather than claiming Station.
    const markup = markupFor(
      formFromAgent({
        slug: 'station',
        name: 'Station',
        execution: { agentConnectionId: 'codex' },
      } as never),
    );
    expect(markup).toContain('Codex');
    expect(markup).not.toContain('<select');
  });
});
