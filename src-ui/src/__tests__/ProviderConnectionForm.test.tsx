/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

let awsProfilesResult: {
  data?: { profiles: string[]; available: boolean };
  isLoading?: boolean;
  isError?: boolean;
  error?: Error | null;
} = { data: undefined, isLoading: true, isError: false, error: null };

vi.mock('@kontourai/station-sdk', () => ({
  useAwsProfilesQuery: () => awsProfilesResult,
}));

import { ProviderConnectionForm } from '../views/provider-settings/ProviderConnectionForm';
import type { ProviderConnection } from '../views/provider-settings/types';

function bedrockForm(
  config: Record<string, unknown> = { region: '' },
): Omit<ProviderConnection, 'id'> {
  return {
    kind: 'model',
    type: 'bedrock',
    name: 'My Bedrock',
    config,
    enabled: true,
    capabilities: ['llm', 'embedding'],
    status: 'ready',
    prerequisites: [],
    lastCheckedAt: null,
  };
}

describe('ProviderConnectionForm — Bedrock auth modes (docs/design/connections-onboarding.md §3.1)', () => {
  beforeEach(() => {
    awsProfilesResult = {
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    };
  });

  test('defaults to the default AWS credential chain and hides profile/api-key inputs', () => {
    const onSetConfigField = vi.fn();
    render(
      <ProviderConnectionForm
        form={bedrockForm()}
        isNew
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={onSetConfigField}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    const select = screen.getByLabelText('Authentication') as HTMLSelectElement;
    expect(select.value).toBe('chain');
    expect(screen.queryByLabelText('AWS profile')).toBeNull();
    expect(screen.queryByLabelText('Bedrock API key')).toBeNull();
  });

  test('selecting the named-profile mode shows the profile picker sourced from useAwsProfilesQuery', () => {
    awsProfilesResult = {
      data: { profiles: ['default', 'work'], available: true },
      isLoading: false,
    };
    const onSetConfigField = vi.fn();
    render(
      <ProviderConnectionForm
        form={bedrockForm({ region: '', authMode: 'profile' })}
        isNew
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={onSetConfigField}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    const profileSelect = screen.getByLabelText(
      'AWS profile',
    ) as HTMLSelectElement;
    const options = Array.from(profileSelect.options).map((o) => o.value);
    expect(options).toEqual(['', 'default', 'work']);
  });

  // loading/error/genuine-empty must be
  // distinguishable — never show the empty message while still loading or
  // while the request failed.
  test('named-profile mode shows a distinct loading message while the profile list is in flight', () => {
    awsProfilesResult = {
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    };
    render(
      <ProviderConnectionForm
        form={bedrockForm({ region: '', authMode: 'profile' })}
        isNew
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={vi.fn()}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Loading AWS profiles')).toBeTruthy();
    expect(screen.queryByText('AWS profiles will appear here')).toBeNull();
    expect(screen.queryByLabelText('AWS profile')).toBeNull();
  });

  test('named-profile mode shows a distinct error message (not the empty message) on failure', () => {
    awsProfilesResult = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('the AWS profiles route failed'),
    };
    render(
      <ProviderConnectionForm
        form={bedrockForm({ region: '', authMode: 'profile' })}
        isNew
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={vi.fn()}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    expect(screen.getByText("Couldn't load AWS profiles")).toBeTruthy();
    expect(screen.getByText('the AWS profiles route failed')).toBeTruthy();
    expect(screen.queryByText('AWS profiles will appear here')).toBeNull();
    expect(screen.queryByLabelText('Loading AWS profiles')).toBeNull();
  });

  test('named-profile mode with no profiles found shows a hint instead of an empty dropdown', () => {
    awsProfilesResult = {
      data: { profiles: [], available: false },
      isLoading: false,
      isError: false,
      error: null,
    };
    render(
      <ProviderConnectionForm
        form={bedrockForm({ region: '', authMode: 'profile' })}
        isNew
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={vi.fn()}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText('AWS profile')).toBeNull();
    expect(
      screen.getByText("An AWS config file wasn't found on this computer."),
    ).toBeTruthy();
  });

  test('selecting the api-key mode shows a password input for the Bedrock API key', () => {
    render(
      <ProviderConnectionForm
        form={bedrockForm({ region: '', authMode: 'api-key' })}
        isNew
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={vi.fn()}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    const input = screen.getByLabelText('Bedrock API key') as HTMLInputElement;
    expect(input.type).toBe('password');
  });

  test('switching away from profile mode clears the stored profile field', () => {
    const onSetConfigField = vi.fn();
    render(
      <ProviderConnectionForm
        form={bedrockForm({ region: '', authMode: 'profile', profile: 'work' })}
        isNew
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={onSetConfigField}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    const select = screen.getByLabelText('Authentication') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'chain' } });

    expect(onSetConfigField).toHaveBeenCalledWith('authMode', 'chain');
    expect(onSetConfigField).toHaveBeenCalledWith('profile', '');
    expect(onSetConfigField).toHaveBeenCalledWith('apiKey', '');
  });

  test('explicitly removes a redacted saved API key', () => {
    const onSetConfigField = vi.fn();
    render(
      <ProviderConnectionForm
        form={{
          ...bedrockForm({
            region: 'us-east-1',
            authMode: 'api-key',
            apiKeyConfigured: true,
          }),
        }}
        isNew={false}
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={onSetConfigField}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove saved key' }));
    expect(onSetConfigField).toHaveBeenCalledWith('apiKeyConfigured', false);
    expect(onSetConfigField).toHaveBeenCalledWith('apiKeyClearRequested', true);
  });

  test('switching to api-key mode clears any stored profile', () => {
    const onSetConfigField = vi.fn();
    render(
      <ProviderConnectionForm
        form={bedrockForm({ region: '', authMode: 'profile', profile: 'work' })}
        isNew
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={onSetConfigField}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    const select = screen.getByLabelText('Authentication') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'api-key' } });

    expect(onSetConfigField).toHaveBeenCalledWith('authMode', 'api-key');
    expect(onSetConfigField).toHaveBeenCalledWith('profile', '');
    expect(onSetConfigField).not.toHaveBeenCalledWith('apiKey', '');
  });
});

function anthropicForm(
  overrides: Partial<Omit<ProviderConnection, 'id'>> = {},
): Omit<ProviderConnection, 'id'> {
  return {
    kind: 'model',
    type: 'anthropic',
    name: 'Anthropic',
    config: {},
    enabled: true,
    capabilities: ['llm'],
    // What the server derives from "a non-empty string is saved in the key
    // box" — the state RT-06 found rendering as "Ready".
    status: 'ready',
    prerequisites: [],
    lastCheckedAt: null,
    ...overrides,
  };
}

const NOT_VERIFIED = {
  evidenceVersion: 1 as const,
  level: 'prerequisite-ready' as const,
  observedAt: '2026-08-20T10:00:00.000Z',
  freshness: 'fresh' as const,
  summary: 'Required prerequisites are currently satisfied.',
  smoke: {
    status: 'not-tested' as const,
    freshness: 'unknown' as const,
    turnLimit: 1 as const,
  },
  check: { status: 'not-checked' as const },
};

describe('ProviderConnectionForm — readiness is derived, not labelled (RT-06/RT-18)', () => {
  test('a saved-but-unverified provider never reads Ready', () => {
    render(
      <ProviderConnectionForm
        form={anthropicForm({ readinessEvidence: NOT_VERIFIED })}
        isNew={false}
        selectedProviderId="anthropic-1"
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={vi.fn()}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    const summary = document.querySelector(
      '.provider-detail__summary',
    ) as HTMLElement;
    expect(summary.textContent).toContain('Saved — not verified');
    expect(summary.textContent).not.toContain('Ready');
  });

  test('a refused check reads Check failed and names the provider’s reason', () => {
    render(
      <ProviderConnectionForm
        form={anthropicForm({
          lastCheckedAt: '2026-08-20T09:59:00.000Z',
          readinessEvidence: {
            ...NOT_VERIFIED,
            level: 'discovered',
            summary: '401 invalid x-api-key',
            action: 'Correct this connection’s settings, then test it again.',
            check: {
              status: 'failed',
              checkedAt: '2026-08-20T09:59:00.000Z',
              reason: '401 invalid x-api-key',
            },
          },
        })}
        isNew={false}
        selectedProviderId="anthropic-1"
        testResult={{ healthy: false, reason: '401 invalid x-api-key' }}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={vi.fn()}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    const summary = document.querySelector(
      '.provider-detail__summary',
    ) as HTMLElement;
    expect(summary.textContent).toContain('Check failed');
    // Last check is no longer "Not checked" after a test that ran.
    expect(summary.textContent).not.toContain('Not checked');
    expect(
      document.querySelector('.provider-detail__notice')?.textContent,
    ).toContain('401 invalid x-api-key');
    expect(
      screen.getByText(/Connection failed — 401 invalid x-api-key/),
    ).toBeTruthy();
  });

  // — reachable, no catalogue: neither Ready nor Check failed.
  test('a catalog-unavailable check reads Reachable — no model catalog', () => {
    render(
      <ProviderConnectionForm
        form={anthropicForm({
          lastCheckedAt: '2026-08-20T09:59:00.000Z',
          readinessEvidence: {
            ...NOT_VERIFIED,
            summary: 'This provider offers no model catalog.',
            action:
              'Run Test Connection, or start a chat, to prove this connection can run work.',
            check: {
              status: 'catalog-unavailable',
              checkedAt: '2026-08-20T09:59:00.000Z',
              reason: 'This provider offers no model catalog.',
              source: 'catalog-discovery',
            },
          },
        })}
        isNew={false}
        selectedProviderId="anthropic-1"
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={vi.fn()}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    const summary = document.querySelector(
      '.provider-detail__summary',
    ) as HTMLElement;
    expect(summary.textContent).toContain('Reachable — no model catalog');
    expect(summary.textContent).not.toContain('Check failed');
    // The rail cannot reach Ready on reachability alone.
    expect(
      Array.from(
        document.querySelectorAll('.provider-detail__progress-step'),
      ).map((step) =>
        step.classList.contains('provider-detail__progress-step--complete'),
      ),
    ).toEqual([true, true, false]);
  });

  // — a passed smoke is a complete chat turn; it must be read
  // before an OLDER refusal, or it can never repair the presentation.
  // and only before an older one: smoke receipts stay
  // fresh for 24 hours, so unconditional precedence rendered Ready over a
  // genuine refusal observed after the smoke.
  function smokeVersusCheck(
    smokeTestedAt: string,
    checkCheckedAt: string,
  ): HTMLElement {
    render(
      <ProviderConnectionForm
        form={anthropicForm({
          readinessEvidence: {
            ...NOT_VERIFIED,
            // The server-derived level for the OLDER-refusal ordering. The
            // screen must reach its own verdict from the two timestamps, not
            // from this word, which is exactly what the newer-refusal case
            // below proves.
            level: 'smoke-passed',
            smoke: {
              status: 'passed',
              freshness: 'fresh',
              testedAt: smokeTestedAt,
              turnLimit: 1,
            },
            check: {
              status: 'failed',
              checkedAt: checkCheckedAt,
              reason: 'Model catalog request failed with HTTP 401.',
              source: 'catalog-discovery',
            },
          },
        })}
        isNew={false}
        selectedProviderId="anthropic-1"
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={vi.fn()}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );
    return document.querySelector('.provider-detail__summary') as HTMLElement;
  }

  test('a passed smoke outranks a refusal observed before it', () => {
    const summary = smokeVersusCheck(
      '2026-08-20T10:00:00.000Z',
      '2026-08-20T09:00:00.000Z',
    );

    expect(summary.textContent).toContain('Ready');
    expect(summary.textContent).not.toContain('Check failed');
  });

  test('a refusal observed after the smoke wins', () => {
    const summary = smokeVersusCheck(
      '2026-08-20T09:00:00.000Z',
      '2026-08-20T10:00:00.000Z',
    );

    expect(summary.textContent).toContain('Check failed');
    expect(summary.textContent).not.toContain('Ready to use');
  });

  // one listing that could not reach the endpoint is a
  // degraded-reachability notice, not a durable refusal.
  test('an unreachable check inside its grace window reads Unreachable — retrying', () => {
    render(
      <ProviderConnectionForm
        form={anthropicForm({
          readinessEvidence: {
            ...NOT_VERIFIED,
            summary: 'fetch failed',
            check: {
              status: 'unreachable',
              retrying: true,
              checkedAt: '2026-08-20T10:00:00.000Z',
              reason: 'fetch failed',
              source: 'catalog-discovery',
            },
          },
        })}
        isNew={false}
        selectedProviderId="anthropic-1"
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={vi.fn()}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    const summary = document.querySelector(
      '.provider-detail__summary',
    ) as HTMLElement;
    expect(summary.textContent).toContain('Unreachable — retrying');
    expect(summary.textContent).not.toContain('Check failed');
  });

  test('an unreachable check past its grace window reads as a fault', () => {
    render(
      <ProviderConnectionForm
        form={anthropicForm({
          readinessEvidence: {
            ...NOT_VERIFIED,
            summary: 'fetch failed',
            check: {
              status: 'unreachable',
              checkedAt: '2026-08-20T10:00:00.000Z',
              reason: 'fetch failed',
              source: 'catalog-discovery',
            },
          },
        })}
        isNew={false}
        selectedProviderId="anthropic-1"
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={vi.fn()}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    const summary = document.querySelector(
      '.provider-detail__summary',
    ) as HTMLElement;
    expect(summary.textContent).toContain('Cannot reach provider');
    expect(summary.textContent).not.toContain('retrying');
  });

  // the button used to promise nothing and the contract
  // called the whole check non-billable.
  test('Test Connection discloses the chat request it may send', () => {
    render(
      <ProviderConnectionForm
        form={anthropicForm({ readinessEvidence: NOT_VERIFIED })}
        isNew={false}
        selectedProviderId="anthropic-1"
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={vi.fn()}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    const button = screen.getByRole('button', { name: 'Test Connection' });
    const disclosure = document.getElementById(
      button.getAttribute('aria-describedby') ?? '',
    );
    expect(disclosure?.textContent).toContain('one minimal chat request');
    expect(disclosure?.textContent).toContain('bill');
  });

  test('Models is a control that loads the catalogue, and the rail tracks real steps', () => {
    const onLoadModels = vi.fn();
    render(
      <ProviderConnectionForm
        form={anthropicForm({ readinessEvidence: NOT_VERIFIED })}
        isNew={false}
        selectedProviderId="anthropic-1"
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={vi.fn()}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
        onLoadModels={onLoadModels}
      />,
    );

    expect(screen.queryByText('Check to load')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    expect(onLoadModels).toHaveBeenCalledTimes(1);

    const steps = Array.from(
      document.querySelectorAll('.provider-detail__progress-step'),
    );
    expect(steps.map((step) => step.textContent)).toEqual([
      'Choose',
      'Connect',
      'Ready',
    ]);
    // Saved on the server, but nothing has reached the provider yet.
    expect(
      steps.map((step) =>
        step.classList.contains('provider-detail__progress-step--complete'),
      ),
    ).toEqual([true, true, false]);
    // The same fact, announced rather than left to a private class name.
    expect(steps.map((step) => step.getAttribute('aria-current'))).toEqual([
      null,
      null,
      'step',
    ]);
  });

  // a `catalog-ready` LEVEL is not enough — every listing runs
  // catalogue discovery, so the level alone could be true while nothing had
  // reached the provider. Ready requires the receipt discovery now writes.
  test('a catalog-ready level with no check receipt still reads Saved — not verified', () => {
    render(
      <ProviderConnectionForm
        form={anthropicForm({
          config: { modelOptions: [{ id: 'a', name: 'A' }] },
          readinessEvidence: { ...NOT_VERIFIED, level: 'catalog-ready' },
        })}
        isNew={false}
        selectedProviderId="anthropic-1"
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={vi.fn()}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    const summary = document.querySelector(
      '.provider-detail__summary',
    ) as HTMLElement;
    expect(summary.textContent).toContain('Saved — not verified');
    expect(
      Array.from(
        document.querySelectorAll('.provider-detail__progress-step'),
      ).map((step) =>
        step.classList.contains('provider-detail__progress-step--complete'),
      ),
    ).toEqual([true, true, false]);
  });

  test('the rail reaches Ready only once a check has passed', () => {
    render(
      <ProviderConnectionForm
        form={anthropicForm({
          config: { modelOptions: [{ id: 'a', name: 'A' }] },
          readinessEvidence: {
            ...NOT_VERIFIED,
            level: 'catalog-ready',
            check: {
              status: 'passed',
              checkedAt: '2026-08-20T09:59:00.000Z',
              source: 'catalog-discovery',
            },
          },
        })}
        isNew={false}
        selectedProviderId="anthropic-1"
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={vi.fn()}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    const steps = Array.from(
      document.querySelectorAll('.provider-detail__progress-step'),
    );
    expect(
      steps.map((step) =>
        step.classList.contains('provider-detail__progress-step--complete'),
      ),
    ).toEqual([true, true, true]);
    // Every step done: nothing is "the current step" any more.
    expect(
      steps.every((step) => step.getAttribute('aria-current') === null),
    ).toBe(true);
    const summary = document.querySelector(
      '.provider-detail__summary',
    ) as HTMLElement;
    expect(summary.textContent).toContain('Ready');
    expect(summary.textContent).toContain('1');
  });
});

function openAiCompatForm(
  config: Record<string, unknown> = {},
): Omit<ProviderConnection, 'id'> {
  return {
    kind: 'model',
    type: 'openai-compat',
    name: 'Local server',
    config: { baseUrl: 'http://localhost:8080/v1', ...config },
    enabled: true,
    capabilities: ['llm'],
    status: 'ready',
    prerequisites: [],
    lastCheckedAt: null,
  };
}

/**
 * archive#3652 — an OpenAI-compatible server that offers no `/models` reads
 * "Reachable — no model catalog", and the explicit test says to set a default
 * model on the connection so the one-token chat request can prove it runs
 * work. That model was API-only: nothing on this form wrote it, so the
 * instruction named an action the user could not take where it was printed.
 *
 * The key name is load-bearing, not cosmetic — `probeChatCompletion` and the
 * runtime's model resolution both read `config.defaultModel`, so the tests
 * assert the field writes THAT key rather than merely that an input exists.
 */
describe('ProviderConnectionForm — openai-compat default model (#3652)', () => {
  test('writes config.defaultModel, the key the chat probe reads', () => {
    const onSetConfigField = vi.fn();
    render(
      <ProviderConnectionForm
        form={openAiCompatForm()}
        isNew={false}
        selectedProviderId="compat-1"
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={onSetConfigField}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    const field = screen.getByLabelText('Default model') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'llama-3.1-8b' } });

    expect(onSetConfigField).toHaveBeenCalledWith(
      'defaultModel',
      'llama-3.1-8b',
    );
  });

  test('shows the model already saved on the connection', () => {
    render(
      <ProviderConnectionForm
        form={openAiCompatForm({ defaultModel: 'llama-3.1-8b' })}
        isNew={false}
        selectedProviderId="compat-1"
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={vi.fn()}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    expect(
      (screen.getByLabelText('Default model') as HTMLInputElement).value,
    ).toBe('llama-3.1-8b');
  });

  test('stays typable when the server offers no catalog to choose from', () => {
    // The whole point of the field: this connection's catalogue is empty or
    // unsupported, so a picker over loaded models would offer nothing and the
    // check could never be satisfied.
    render(
      <ProviderConnectionForm
        form={openAiCompatForm({ modelOptions: [] })}
        isNew={false}
        selectedProviderId="compat-1"
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={vi.fn()}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    expect(
      (screen.getByLabelText('Default model') as HTMLElement).tagName,
    ).toBe('INPUT');
  });

  test('offers the loaded models when the server does have a catalog', () => {
    render(
      <ProviderConnectionForm
        form={openAiCompatForm({
          modelOptions: [
            { id: 'llama-3.1-8b', name: 'Llama 3.1 8B' },
            { id: 'qwen2.5-7b', name: 'Qwen2.5 7B' },
          ],
        })}
        isNew={false}
        selectedProviderId="compat-1"
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={vi.fn()}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    const select = screen.getByLabelText('Default model') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      '',
      'llama-3.1-8b',
      'qwen2.5-7b',
    ]);
  });
});

/**
 * archive#3654 — a Bedrock catalogue denial is now classified as "reachable, no
 * catalog", so the explicit test goes on to the one minimal chat request that
 * can still prove the connection. That request needs a default model, and
 * without a field for it the check would print an instruction with nowhere to
 * carry it out.
 */
describe('ProviderConnectionForm — Bedrock default model (#3654)', () => {
  beforeEach(() => {
    awsProfilesResult = {
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    };
  });

  test('writes config.defaultModel, the key the chat probe reads', () => {
    const onSetConfigField = vi.fn();
    render(
      <ProviderConnectionForm
        form={bedrockForm({ region: 'us-east-1' })}
        isNew={false}
        selectedProviderId="bedrock-1"
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={onSetConfigField}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Default model'), {
      target: { value: 'anthropic.claude-3-haiku-20240307-v1:0' },
    });

    expect(onSetConfigField).toHaveBeenCalledWith(
      'defaultModel',
      'anthropic.claude-3-haiku-20240307-v1:0',
    );
  });

  test('stays typable for an account that cannot list Bedrock models', () => {
    render(
      <ProviderConnectionForm
        form={bedrockForm({ region: 'us-east-1', modelOptions: [] })}
        isNew={false}
        selectedProviderId="bedrock-1"
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={vi.fn()}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    expect(
      (screen.getByLabelText('Default model') as HTMLElement).tagName,
    ).toBe('INPUT');
  });
});

/**
 * Review — the chat probe reads `config.defaultModel` for EVERY model
 * provider, so an Anthropic or Google connection whose catalogue comes back
 * empty or unsupported is told to set a default model as well. Their form
 * exposed only an API key, which left that instruction API-only for them.
 */
describe('ProviderConnectionForm — Anthropic and Google default model (review M1)', () => {
  test.each(['anthropic', 'google'])(
    '%s writes config.defaultModel, the key the chat probe reads',
    (type) => {
      const onSetConfigField = vi.fn();
      render(
        <ProviderConnectionForm
          form={anthropicForm({ type, config: {} })}
          isNew={false}
          selectedProviderId={`${type}-1`}
          testResult={null}
          testError={null}
          isTesting={false}
          onSetField={vi.fn()}
          onSetConfigField={onSetConfigField}
          onTypeChange={vi.fn()}
          onTestConnection={vi.fn()}
        />,
      );

      fireEvent.change(screen.getByLabelText('Default model'), {
        target: { value: 'a-model-id' },
      });

      expect(onSetConfigField).toHaveBeenCalledWith(
        'defaultModel',
        'a-model-id',
      );
    },
  );

  test('offers the loaded models when the provider does have a catalog', () => {
    render(
      <ProviderConnectionForm
        form={anthropicForm({
          config: {
            modelOptions: [{ id: 'claude-x', name: 'Claude X' }],
          },
        })}
        isNew={false}
        selectedProviderId="anthropic-1"
        testResult={null}
        testError={null}
        isTesting={false}
        onSetField={vi.fn()}
        onSetConfigField={vi.fn()}
        onTypeChange={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    const select = screen.getByLabelText('Default model') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      '',
      'claude-x',
    ]);
  });
});
