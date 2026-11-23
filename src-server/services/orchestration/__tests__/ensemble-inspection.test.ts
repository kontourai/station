import { createHash } from 'node:crypto';
import { realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ENSEMBLE_PRESET_VERSION } from '@kontourai/station-contracts/ensemble';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { inspectEnsemblePreset } from '../ensemble-inspection.js';
import { loadEnsemblePreset } from '../ensemble-presets.js';

vi.mock('../ensemble-presets.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../ensemble-presets.js')>();
  return { ...actual, loadEnsemblePreset: vi.fn(actual.loadEnsemblePreset) };
});

const temporary = trackTempDirs();

async function fixture() {
  const directory = await realpath(temporary('station-ensemble-inspection-'));
  const path = join(directory, 'preset.json');
  const privateBrief = 'private member prompt must stay with its owner';
  const json = `${JSON.stringify(
    {
      version: ENSEMBLE_PRESET_VERSION,
      id: 'review',
      name: 'Independent\nreview',
      stationmaster: 'lead',
      members: [
        {
          id: 'lead',
          codename: 'Aster',
          color: '#124578',
          role: 'review\nindependently',
          engine: 'codex',
          model: 'authored-model\u001b',
          reasoning: { option: 'reasoningEffort', value: 'high' },
          options: { fastMode: false },
          promptAppends: [privateBrief],
        },
      ],
    },
    null,
    2,
  )}\n`;
  await writeFile(path, json);

  const input = {
    path,
    contextKey: 'private-owner-context',
    expectedPresetHash: `sha256:${createHash('sha256').update(json).digest('hex')}`,
  };
  const original = { ...input };
  let revoked = false;
  const current: Parameters<typeof inspectEnsemblePreset>[1] = (binding) =>
    !revoked &&
    binding.path === original.path &&
    binding.contextKey === original.contextKey &&
    binding.expectedPresetHash === original.expectedPresetHash;
  return {
    directory,
    input,
    original,
    current,
    json,
    privateBrief,
    revoke: () => {
      revoked = true;
    },
  };
}

test('inspects exact authored declarations without source bytes or preparation claims', async () => {
  const f = await fixture();
  const inspection = await inspectEnsemblePreset(f.input, f.current);

  expect(inspection).toEqual({
    source: {
      version: ENSEMBLE_PRESET_VERSION,
      sha256: f.input.expectedPresetHash,
      presetId: 'review',
      name: 'Independent review',
      stationmaster: 'lead',
    },
    members: [
      {
        id: 'lead',
        codename: 'Aster',
        color: '#124578',
        role: 'review independently',
        engine: 'codex',
        model: 'authored-model ',
        reasoning: { option: 'reasoningEffort', value: 'high' },
        options: { fastMode: false },
      },
    ],
  });
  const serialized = JSON.stringify(inspection);
  for (const detail of [f.input.path, f.input.contextKey, f.privateBrief])
    expect(serialized).not.toContain(detail);
  expect(() =>
    Object.assign(inspection.members[0].options, { fastMode: true }),
  ).toThrow();
});

test('refuses an unbound caller before consulting the holder', async () => {
  const f = await fixture();
  vi.mocked(loadEnsemblePreset).mockClear();
  await expect(
    inspectEnsemblePreset(
      { ...f.input, contextKey: 'other-context' },
      f.current,
    ),
  ).rejects.toMatchObject({ code: 'ensemble_inspection_authority_required' });
  expect(loadEnsemblePreset).not.toHaveBeenCalled();
});

test('checks every byte of an explicitly pinned preset', async () => {
  const f = await fixture();
  const edited = `${f.json}\n`;
  await writeFile(f.input.path, edited);
  await expect(inspectEnsemblePreset(f.input, f.current)).rejects.toMatchObject(
    {
      code: 'ensemble_inspection_stale',
    },
  );
  const { path, contextKey } = f.input;
  const refreshed = await inspectEnsemblePreset(
    { path, contextKey },
    (binding) =>
      binding.path === path &&
      binding.contextKey === contextKey &&
      binding.expectedPresetHash === undefined,
  );
  expect(refreshed.source.sha256).toBe(
    `sha256:${createHash('sha256').update(edited).digest('hex')}`,
  );
});

test('keeps raw invalid preset bytes out of inspection errors', async () => {
  const f = await fixture();
  await writeFile(f.input.path, `{${f.privateBrief}`);
  await expect(inspectEnsemblePreset(f.input, f.current)).rejects.toMatchObject(
    {
      code: 'ensemble_inspection_unavailable',
      message: 'ensemble_inspection_unavailable',
    },
  );
});

test('holds the selected caller, path, and hash across the holder await', async () => {
  const f = await fixture();
  const actual = await vi.importActual<typeof import('../ensemble-presets.js')>(
    '../ensemble-presets.js',
  );
  vi.mocked(loadEnsemblePreset).mockImplementationOnce(async (...args) => {
    Object.assign(f.input, {
      path: join(f.directory, 'other.json'),
      contextKey: 'other-context',
      expectedPresetHash: `sha256:${'0'.repeat(64)}`,
    });
    return actual.loadEnsemblePreset(...args);
  });

  const inspection = await inspectEnsemblePreset(f.input, f.current);
  expect(inspection.source.sha256).toBe(f.original.expectedPresetHash);
  expect(inspection.source.presetId).toBe('review');
});

test.each(['caller withdrawal', 'same-byte replacement'] as const)(
  'refuses disclosure after the retained holder resolves with %s',
  async (change) => {
    const f = await fixture();
    const actual = await vi.importActual<
      typeof import('../ensemble-presets.js')
    >('../ensemble-presets.js');
    let changed = false;
    vi.mocked(loadEnsemblePreset).mockImplementationOnce(async (...args) => {
      const source = await actual.loadEnsemblePreset(...args);
      if (change === 'caller withdrawal') f.revoke();
      else {
        const replacement = join(f.directory, 'replacement.json');
        await writeFile(replacement, f.json);
        await rename(replacement, f.input.path);
      }
      changed = true;
      return source;
    });
    await expect(
      inspectEnsemblePreset(f.input, f.current),
    ).rejects.toMatchObject({
      code:
        change === 'caller withdrawal'
          ? 'ensemble_inspection_authority_required'
          : 'ensemble_inspection_stale',
    });
    expect(changed).toBe(true);
  },
);
