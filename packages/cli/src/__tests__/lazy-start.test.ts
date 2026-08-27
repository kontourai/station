import type { InstanceConfig } from '@kontourai/station-shared/instance-registry';
import { describe, expect, test, vi } from 'vitest';
import { type LazyStartDeps, runLazyStart } from '../commands/lazy-start.js';

function instance(overrides: Partial<InstanceConfig> = {}): InstanceConfig {
  return { port: 3141, uiPort: 3000, type: 'inline', pid: 1234, ...overrides };
}

function baseDeps(overrides: Partial<LazyStartDeps> = {}): LazyStartDeps {
  return {
    isInteractive: false,
    findRunning: () => [],
    probe: async () => true,
    openBrowser: vi.fn(async () => true),
    log: vi.fn(),
    runners: {
      inline: vi.fn(async () => {}),
      service: vi.fn(async () => {}),
      tempHome: vi.fn(async () => {}),
    },
    ...overrides,
  };
}

describe('runLazyStart — a Station is already running', () => {
  test('uses the selected runtime UI port for an older record without uiPort', async () => {
    const openBrowser = vi.fn(async () => true);
    const target: InstanceConfig = { port: 18141, type: 'inline', pid: 1234 };
    await runLazyStart(
      {},
      baseDeps({
        findRunning: () => [target],
        openBrowser,
        mintToken: async () => null,
      }),
    );

    expect(openBrowser).toHaveBeenCalledWith('http://localhost:18000');
  });

  test('opens the running UI with a minted bootstrap token in the fragment', async () => {
    const openBrowser = vi.fn(async () => true);
    const mintToken = vi.fn(async () => 'tok-abc');
    const deps = baseDeps({
      findRunning: () => [instance({ uiPort: 5000, port: 3242 })],
      openBrowser,
      mintToken,
    });

    await runLazyStart({}, deps);

    expect(mintToken).toHaveBeenCalledWith(3242, undefined, expect.any(String));
    expect(openBrowser).toHaveBeenCalledWith(
      'http://localhost:5000#station-ui-bootstrap=tok-abc',
    );
    expect(deps.runners.inline).not.toHaveBeenCalled();
  });

  test('opens without a fragment when the token mint fails', async () => {
    const openBrowser = vi.fn(async () => true);
    const deps = baseDeps({
      findRunning: () => [instance({ uiPort: 5000 })],
      openBrowser,
      mintToken: async () => null,
    });

    await runLazyStart({}, deps);

    expect(openBrowser).toHaveBeenCalledWith('http://localhost:5000');
  });

  test('maps a positional directory to the project query parameter', async () => {
    const openBrowser = vi.fn(async () => true);
    const deps = baseDeps({
      findRunning: () => [instance({ uiPort: 5000 })],
      openBrowser,
      mintToken: async () => null,
    });

    await runLazyStart({ dir: '/workspaces/my-project/' }, deps);

    expect(openBrowser).toHaveBeenCalledWith(
      'http://localhost:5000?project=my-project',
    );
  });

  test('never logs the token — only the bare address', async () => {
    const log = vi.fn();
    const deps = baseDeps({
      findRunning: () => [instance({ uiPort: 5000 })],
      log,
      mintToken: async () => 'super-secret-token',
    });

    await runLazyStart({}, deps);

    expect(log.mock.calls.flat().join('\n')).not.toContain(
      'super-secret-token',
    );
  });

  test('prints a manual-open instruction when the browser opener fails', async () => {
    const log = vi.fn();
    await runLazyStart(
      {},
      baseDeps({
        findRunning: () => [instance({ uiPort: 5000 })],
        openBrowser: async () => false,
        log,
      }),
    );

    expect(log).toHaveBeenCalledWith(
      'Could not open Station automatically. Open http://localhost:5000 manually.',
    );
  });

  test('manual-open message preserves the ?project= selector but never the token', async () => {
    const log = vi.fn();
    await runLazyStart(
      { dir: '/workspaces/my-project/' },
      baseDeps({
        findRunning: () => [instance({ uiPort: 5000 })],
        openBrowser: async () => false,
        mintToken: async () => 'super-secret-token',
        log,
      }),
    );

    expect(log).toHaveBeenCalledWith(
      'Could not open Station automatically. Open http://localhost:5000?project=my-project manually.',
    );
    expect(log.mock.calls.flat().join('\n')).not.toContain(
      'super-secret-token',
    );
  });

  test('skips instances that fail the probe and opens the first live one', async () => {
    const probe = vi.fn(async (port: number) => port === 3242);
    const openBrowser = vi.fn(async () => true);
    const deps = baseDeps({
      findRunning: () => [
        instance({ port: 3141, uiPort: 3000 }),
        instance({ port: 3242, uiPort: 5000 }),
      ],
      probe,
      openBrowser,
      mintToken: async () => null,
    });

    await runLazyStart({}, deps);

    expect(openBrowser).toHaveBeenCalledWith('http://localhost:5000');
  });
});

describe('runLazyStart — nothing running', () => {
  test('a flag skips the prompt and runs that path directly', async () => {
    const inline = vi.fn(async () => {});
    const service = vi.fn(async () => {});
    const tempHome = vi.fn(async () => {});
    const runners = { inline, service, tempHome };

    await runLazyStart({ inline: true }, baseDeps({ runners }));
    expect(inline).toHaveBeenCalledTimes(1);

    await runLazyStart(
      { service: true },
      baseDeps({ runners: { ...runners, inline: vi.fn() } }),
    );
    expect(service).toHaveBeenCalledTimes(1);

    await runLazyStart(
      { tempHome: true },
      baseDeps({ runners: { ...runners, inline: vi.fn(), service: vi.fn() } }),
    );
    expect(tempHome).toHaveBeenCalledTimes(1);
  });

  test('prompts in a TTY and routes the choice', async () => {
    const inline = vi.fn(async () => {});
    const select = vi.fn(async () => 'inline' as const);
    await runLazyStart(
      {},
      baseDeps({
        isInteractive: true,
        select,
        runners: { inline, service: vi.fn(), tempHome: vi.fn() },
      }),
    );
    expect(select).toHaveBeenCalledTimes(1);
    expect(inline).toHaveBeenCalledTimes(1);
  });

  test('routes a service choice from the prompt', async () => {
    const service = vi.fn(async () => {});
    await runLazyStart(
      {},
      baseDeps({
        isInteractive: true,
        select: async () => 'service',
        runners: { inline: vi.fn(), service, tempHome: vi.fn() },
      }),
    );
    expect(service).toHaveBeenCalledTimes(1);
  });

  test('a cancelled prompt runs nothing', async () => {
    const runners = {
      inline: vi.fn(async () => {}),
      service: vi.fn(async () => {}),
      tempHome: vi.fn(async () => {}),
    };
    await runLazyStart(
      {},
      baseDeps({ isInteractive: true, select: async () => null, runners }),
    );
    expect(runners.inline).not.toHaveBeenCalled();
    expect(runners.service).not.toHaveBeenCalled();
    expect(runners.tempHome).not.toHaveBeenCalled();
  });

  test('non-TTY with no flag is deterministic: prints usage, runs nothing', async () => {
    const printUsage = vi.fn();
    const runners = {
      inline: vi.fn(async () => {}),
      service: vi.fn(async () => {}),
      tempHome: vi.fn(async () => {}),
    };
    await runLazyStart(
      {},
      baseDeps({ isInteractive: false, printUsage, runners }),
    );
    expect(printUsage).toHaveBeenCalledTimes(1);
    expect(runners.inline).not.toHaveBeenCalled();
  });

  test('a dead-probe instance is treated as nothing running', async () => {
    const inline = vi.fn(async () => {});
    await runLazyStart(
      { inline: true },
      baseDeps({
        findRunning: () => [instance()],
        probe: async () => false,
        runners: { inline, service: vi.fn(), tempHome: vi.fn() },
      }),
    );
    expect(inline).toHaveBeenCalledTimes(1);
  });
});
