/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ProjectWebMcpShare } from '../ProjectWebMcp';

const project = {
  name: 'Checkout refresh',
  description: 'Simplify the payment form',
  workingDirectory: '/private/workspace',
};
const shareLabel = /^(Share summary|Stop sharing)$/;
const scope = {
  apiBase: 'https://station.test',
  authorityKey: 'credential-generation-1',
  isCurrent: () => true,
};

function share(projectId: string, shareScope = scope) {
  return (
    <ProjectWebMcpShare
      project={{ ...project, id: projectId }}
      scope={shareScope}
    />
  );
}

function installModelContext() {
  vi.stubGlobal('isSecureContext', true);
  const registrations: Array<{
    tool: { name: string; execute(): object };
    signal: AbortSignal;
  }> = [];
  Object.defineProperty(document, 'modelContext', {
    configurable: true,
    value: {
      getTools: () => registrations,
      async registerTool(
        tool: (typeof registrations)[number]['tool'],
        { signal }: { signal: AbortSignal },
      ) {
        registrations.push({ tool, signal });
      },
    },
  });
  return registrations;
}

afterEach(() => {
  Reflect.deleteProperty(document, 'modelContext');
  vi.unstubAllGlobals();
});

test('the sharing action is available only in a secure browser with WebMCP', () => {
  vi.stubGlobal('isSecureContext', true);
  const view = render(share('checkout'));
  expect(screen.queryByRole('button', { name: shareLabel })).toBeNull();
  const registrations = installModelContext();
  vi.stubGlobal('isSecureContext', false);
  view.rerender(share('checkout'));
  expect(screen.queryByRole('button', { name: shareLabel })).toBeNull();
  expect(registrations).toHaveLength(0);
});

test('explicit sharing exposes just the Project summary and ends on stop or Project switch', async () => {
  const registrations = installModelContext();
  const view = render(share('checkout'));
  const toggle = () => screen.getByRole('button', { name: shareLabel });
  expect(registrations).toHaveLength(0);
  fireEvent.click(toggle());
  await waitFor(() =>
    expect(toggle().getAttribute('aria-pressed')).toBe('true'),
  );
  const first = registrations[0]!;
  expect(first.tool.name).toBe('station_current_project');
  expect(first.tool.execute()).toEqual({
    name: project.name,
    description: project.description,
  });
  fireEvent.click(toggle());
  expect(first.signal.aborted).toBe(true);
  expect(first.tool.execute()).toHaveProperty('error');

  fireEvent.click(toggle());
  await waitFor(() =>
    expect(toggle().getAttribute('aria-pressed')).toBe('true'),
  );
  const second = registrations[1]!;
  view.rerender(share('different-project'));
  expect(second.signal.aborted).toBe(true);
  expect(second.tool.execute()).toHaveProperty('error');
  expect(toggle().getAttribute('aria-pressed')).toBe('false');
  expect(registrations).toHaveLength(2);
});

test('a registered tool refuses a stale Station scope before React rerenders', async () => {
  const registrations = installModelContext();
  let isCurrent = true;
  render(share('checkout', { ...scope, isCurrent: () => isCurrent }));
  fireEvent.click(screen.getByRole('button', { name: shareLabel }));
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: shareLabel })
        .getAttribute('aria-pressed'),
    ).toBe('true'),
  );
  const registration = registrations[0]!;
  isCurrent = false;
  expect(registration.tool.execute()).toEqual({
    error: 'This Project summary is no longer shared.',
  });
});
