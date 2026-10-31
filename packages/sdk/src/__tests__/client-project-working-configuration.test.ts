import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import { fetchProjectWorkingConfiguration } from '../client/project-working-configuration';

afterEach(() => {
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
});
const authority = {
  apiBase: 'http://working.test',
  authorityKey: 'test',
  isCurrent: () => true,
};
beforeEach(() =>
  setClientCredentialResolver(() => ({
    origin: authority.apiBase,
    requestAuthority: authority,
  })),
);
test.each([404, 501])(
  'an unsupported or refused host (%s) produces actionable unavailable guidance',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ success: false, error: 'unavailable' }, { status }),
      ),
    );
    await expect(
      fetchProjectWorkingConfiguration(authority.apiBase, 'work', {
        requestScope: authority,
      }),
    ).rejects.toThrow(
      'Project working configuration is unavailable. Enable its Feature Preview or update this Station.',
    );
  },
);
test('unknown successful response shapes are refused instead of becoming editable defaults', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        success: true,
        data: { projectId: 'work', sourceDigest: 'untrusted' },
      }),
    ),
  );
  await expect(
    fetchProjectWorkingConfiguration(authority.apiBase, 'work', {
      requestScope: authority,
    }),
  ).rejects.toThrow();
});
