import { describe, expect, test, vi } from 'vitest';
import {
  advertisedAcpSessionModes,
  applyAdvertisedAcpSessionMode,
  requestedAcpSessionMode,
} from '../adapters/acp-session-mode.js';

describe('advertisedAcpSessionModes', () => {
  test('prefers configOptions category mode over the older modes field', () => {
    expect(
      advertisedAcpSessionModes({
        configOptions: [
          {
            id: 'mode',
            category: 'mode',
            currentValue: 'plan',
            options: [
              { value: 'build', name: 'Build' },
              {
                value: 'plan',
                name: 'Plan',
                description: 'Read-only planning',
              },
            ],
          },
        ],
        modes: {
          currentModeId: 'code',
          availableModes: [{ id: 'code', name: 'Code' }],
        },
      }),
    ).toEqual({
      currentModeId: 'plan',
      configOptionId: 'mode',
      modes: [
        { id: 'build', name: 'Build' },
        { id: 'plan', name: 'Plan', description: 'Read-only planning' },
      ],
    });
  });

  test('falls back to modes.availableModes when no mode config option exists', () => {
    expect(
      advertisedAcpSessionModes({
        configOptions: [{ id: 'model', category: 'model', options: [] }],
        modes: {
          currentModeId: 'ask',
          availableModes: [
            { id: 'ask', name: 'Ask', description: 'Request permission' },
            { id: 'code', name: 'Code' },
          ],
        },
      }),
    ).toEqual({
      currentModeId: 'ask',
      modes: [
        { id: 'ask', name: 'Ask', description: 'Request permission' },
        { id: 'code', name: 'Code' },
      ],
    });
  });
});

describe('requestedAcpSessionMode', () => {
  test('reads a non-empty mode string from the modelOptions bag', () => {
    expect(requestedAcpSessionMode({ mode: 'plan' })).toBe('plan');
    expect(requestedAcpSessionMode({ mode: '  ' })).toBeUndefined();
    expect(requestedAcpSessionMode({ approvalMode: 'ask' })).toBeUndefined();
  });
});

describe('applyAdvertisedAcpSessionMode', () => {
  test('uses setConfigOption when a mode config option was advertised', async () => {
    const process = {
      setConfigOption: vi.fn(async () => ({
        configOptions: [
          {
            id: 'mode',
            category: 'mode',
            currentValue: 'plan',
            options: [
              { value: 'build', name: 'Build' },
              { value: 'plan', name: 'Plan' },
            ],
          },
        ],
      })),
      setMode: vi.fn(async () => {}),
    };
    const catalog = advertisedAcpSessionModes({
      configOptions: [
        {
          id: 'mode',
          category: 'mode',
          currentValue: 'build',
          options: [
            { value: 'build', name: 'Build' },
            { value: 'plan', name: 'Plan' },
          ],
        },
      ],
    });

    await expect(
      applyAdvertisedAcpSessionMode(process, catalog, 'plan', 'opencode'),
    ).resolves.toMatchObject({ currentModeId: 'plan' });
    expect(process.setConfigOption).toHaveBeenCalledWith('mode', 'plan');
    expect(process.setMode).not.toHaveBeenCalled();
  });

  test('uses session/set_mode when only the older modes catalog exists', async () => {
    const process = {
      setConfigOption: vi.fn(async () => ({})),
      setMode: vi.fn(async () => {}),
    };
    const catalog = advertisedAcpSessionModes({
      modes: {
        currentModeId: 'ask',
        availableModes: [
          { id: 'ask', name: 'Ask' },
          { id: 'code', name: 'Code' },
        ],
      },
    });

    await expect(
      applyAdvertisedAcpSessionMode(process, catalog, 'code', 'gemini'),
    ).resolves.toEqual({ currentModeId: 'code' });
    expect(process.setMode).toHaveBeenCalledWith('code');
    expect(process.setConfigOption).not.toHaveBeenCalled();
  });

  test('refuses a value the catalog did not advertise', async () => {
    const process = {
      setConfigOption: vi.fn(async () => ({})),
      setMode: vi.fn(async () => {}),
    };
    const catalog = advertisedAcpSessionModes({
      modes: { availableModes: [{ id: 'build', name: 'Build' }] },
    });
    await expect(
      applyAdvertisedAcpSessionMode(process, catalog, 'yolo', 'kiro'),
    ).rejects.toThrow('ACP mode value unsupported');
    expect(process.setMode).not.toHaveBeenCalled();
  });

  test('is a no-op when the requested mode is already current', async () => {
    const process = {
      setConfigOption: vi.fn(async () => ({})),
      setMode: vi.fn(async () => {}),
    };
    const catalog = advertisedAcpSessionModes({
      modes: {
        currentModeId: 'plan',
        availableModes: [{ id: 'plan', name: 'Plan' }],
      },
    });
    await expect(
      applyAdvertisedAcpSessionMode(process, catalog, 'plan', 'kiro'),
    ).resolves.toEqual({ currentModeId: 'plan' });
    expect(process.setMode).not.toHaveBeenCalled();
  });
});
