/**
 * @vitest-environment jsdom
 *
 * DESIGN.md §4: "Create is disabled until the engine choice is made AND that
 * engine is Ready (the fixing action is shown inline instead of a validation
 * error after submit — shot 17's failure mode is impossible)."
 *
 * Shot 17 of the audit is a New Agent form that accepted a name, a template
 * and a prompt, and answered the Create button with "Choose a ready engine
 * before saving" — a requirement the form had never mentioned, discovered by
 * pressing the only button on the page. This file pins both halves of the
 * replacement: the predicate that decides, and the button that obeys it.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { AgentsViewEditorPane } from '../views/agent-editor/AgentsViewEditorPane';
import {
  createEmptyAgentForm,
  createEngineIsReady,
} from '../views/agent-editor/agentsViewUtils';

vi.mock('@kontourai/station-sdk', () => ({
  useAgentConnectionsQuery: () => ({ data: [] }),
  useModelConnectionsQuery: () => ({ data: [] }),
  useProjectsQuery: () => ({ data: [] }),
  useCredentialRecoveryQuery: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
  }),
}));

describe('the Create readiness gate (§4)', () => {
  test('a Station-engine create waits on a selectable managed connection', () => {
    expect(
      createEngineIsReady({
        engineKind: 'model',
        stationEngineSelectable: false,
        // A CLI being ready is irrelevant to the engine this agent chose.
        namedCliEngineSelectable: true,
      }),
    ).toBe(false);
    expect(
      createEngineIsReady({
        engineKind: 'model',
        stationEngineSelectable: true,
        namedCliEngineSelectable: false,
      }),
    ).toBe(true);
  });

  test('a CLI create waits on the CLI it named, not on Station', () => {
    expect(
      createEngineIsReady({
        engineKind: 'cli',
        stationEngineSelectable: true,
        namedCliEngineSelectable: false,
      }),
    ).toBe(false);
    expect(
      createEngineIsReady({
        engineKind: 'cli',
        stationEngineSelectable: false,
        namedCliEngineSelectable: true,
      }),
    ).toBe(true);
  });

  function renderPane(createBlocked: boolean) {
    return render(
      <AgentsViewEditorPane
        isLoading={false}
        notFound={false}
        loadError={null}
        error={null}
        isCreating={true}
        startingPointChosen={true}
        copyPicking={false}
        onCopyPicking={vi.fn()}
        onStartWithModel={vi.fn()}
        onStartWithCli={vi.fn()}
        onDuplicate={vi.fn()}
        onCopyAgent={vi.fn()}
        onFixAgent={vi.fn()}
        engineKind="cli"
        onEngineKindChange={vi.fn()}
        stationConnectionId=""
        createBlocked={createBlocked}
        promptIsRequired={false}
        createdNotice={null}
        onChat={vi.fn()}
        agents={[]}
        selectedSlug={null}
        selectedAgent={undefined}
        isAcp={false}
        isPlugin={false}
        locked={false}
        isLocked={false}
        dirty={false}
        isSaving={false}
        validationErrors={{}}
        availableTools={[]}
        availableSkills={[]}
        integrationTools={{}}
        appConfig={{}}
        enrich={vi.fn()}
        isEnriching={false}
        onNavigate={vi.fn()}
        onDeselect={vi.fn()}
        onRetryLoad={vi.fn()}
        onDelete={vi.fn()}
        onSave={vi.fn()}
        onUnlockPlugin={vi.fn()}
        form={createEmptyAgentForm()}
        setForm={vi.fn()}
        selectedIsUnmaterializedEngine={false}
        onEnable={vi.fn()}
        enableInFlight={false}
        enableError={null}
        onConfigureConnection={vi.fn()}
        toolsActivating={false}
        toolsActivationTimedOut={false}
        onRetryActivation={vi.fn()}
      />,
    );
  }

  test('Create is disabled while the chosen engine is not Ready', () => {
    renderPane(true);
    expect(
      screen
        .getByRole('button', { name: /Create Agent/ })
        .hasAttribute('disabled'),
    ).toBe(true);
  });

  test('Create is pressable once the chosen engine is Ready', () => {
    renderPane(false);
    expect(
      screen
        .getByRole('button', { name: /Create Agent/ })
        .hasAttribute('disabled'),
    ).toBe(false);
  });
});
