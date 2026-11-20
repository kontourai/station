import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { ClaudeAdapter } from '../adapters/claude-adapter.js';
import {
  deriveConfigHomeAffinity,
  resolveConfigHomeAffinity,
} from '../sessions/transcript-file-io.js';

// The Agent SDK is loaded on first use (scripts/lib/server-static-imports.mjs);
// here every load of it fails (vitest reports the factory's error as a mocking
// error).
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  throw new Error('agent sdk unavailable');
});

const makeTempDir = trackTempDirs();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ClaudeAdapter when the Agent SDK cannot load', () => {
  test('adoption fails before it reports child creation', async () => {
    const home = makeTempDir('station-claude-sdk-load-');
    vi.stubEnv('CLAUDE_CONFIG_DIR', home);
    const identity = deriveConfigHomeAffinity('claude-config-home', home)!;
    const adapter = new ClaudeAdapter({
      resolveSourceHome: (affinity) =>
        resolveConfigHomeAffinity('claude-config-home', home, affinity),
    });
    const hooks = {
      onProviderChildCreationStarted: vi.fn(),
      onProviderChildCreated: vi.fn(),
    };
    await expect(
      adapter.adoptSession(
        {
          provider: 'claude',
          threadId: 'station-child',
          sourceSessionId: 'vendor-source',
          sourceKind: 'claude-transcript',
          cwd: join(home, 'project'),
          sourceAffinity: identity.affinity,
        },
        hooks,
      ),
    ).rejects.toThrow(/error when mocking a module/);
    // No child can exist, so the reservation-cleanup path must not start.
    expect(hooks.onProviderChildCreationStarted).not.toHaveBeenCalled();
    expect(hooks.onProviderChildCreated).not.toHaveBeenCalled();
  });
});
