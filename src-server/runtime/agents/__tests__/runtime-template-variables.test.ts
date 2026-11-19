import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  captureLoggerLines,
  stopLoggerCaptures,
} from '../../../__test-utils__/logger-capture.js';

const getCachedUser = vi.fn(() => ({
  alias: 'casey',
  name: 'Casey Example',
  email: 'casey@example.com',
  title: 'Founder',
}));

vi.mock('../../../routes/system/auth.js', () => ({
  getCachedUser,
}));

const { replaceRuntimeTemplateVariables } = await import(
  '../runtime-template-variables.js'
);

describe('replaceRuntimeTemplateVariables', () => {
  afterEach(() => {
    stopLoggerCaptures();
    vi.restoreAllMocks();
    vi.useRealTimers();
    getCachedUser.mockReturnValue({
      alias: 'casey',
      name: 'Casey Example',
      email: 'casey@example.com',
      title: 'Founder',
    });
  });

  test('degrades gracefully when appConfig is undefined (Strands boot path)', () => {
    // The Strands adapter resolves agent instructions eagerly during bootstrap,
    // before StationRuntime.appConfig is assigned — this used to crash with
    // "Cannot read properties of undefined (reading 'templateVariables')".
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-10T18:45:12.000Z'));
    expect(() =>
      replaceRuntimeTemplateVariables(
        'Hi {{user_alias}} on {{iso_date}}',
        undefined,
      ),
    ).not.toThrow();
    const result = replaceRuntimeTemplateVariables(
      'Hi {{user_alias}} on {{iso_date}}',
      undefined,
    );
    expect(result).toBe('Hi casey on 2026-04-10');
    vi.useRealTimers();
  });

  test('replaces built-in, user, and configured variables', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-10T18:45:12.000Z'));

    const result = replaceRuntimeTemplateVariables(
      [
        'Alias: {{user_alias}}',
        'Name: {{user_name}}',
        'Email: {{user_email}}',
        'Title: {{user_title}}',
        'Project: {{project_name}}',
        'ISO: {{iso_date}}',
      ].join('\n'),
      {
        region: 'us-west-2',
        defaultModel: 'claude-sonnet',
        invokeModel: 'claude-sonnet',
        structureModel: 'claude-sonnet',
        templateVariables: [
          {
            key: 'project_name',
            type: 'static',
            value: 'Work Agent',
          },
        ],
      },
    );

    expect(result).toContain('Alias: casey');
    expect(result).toContain('Name: Casey Example');
    expect(result).toContain('Email: casey@example.com');
    expect(result).toContain('Title: Founder');
    expect(result).toContain('Project: Work Agent');
    expect(result).toContain('ISO: 2026-04-10');

    vi.useRealTimers();
  });

  test('uses explicit Intl options and preserves the host locale for omitted formats', () => {
    const now = new Date('2026-04-10T18:45:12.123Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const result = replaceRuntimeTemplateVariables(
      '{{meeting}} | {{local_time}} | {{local_date}}',
      {
        defaultModel: 'fixture',
        invokeModel: 'fixture',
        structureModel: 'fixture',
        templateVariables: [
          {
            key: 'meeting',
            type: 'datetime',
            format:
              '{"timeZone":"UTC","hour":"2-digit","minute":"2-digit","hour12":false}',
          },
          { key: 'local_time', type: 'time' },
          { key: 'local_date', type: 'date', format: '' },
        ],
      },
    );
    expect(result).toBe(
      ['18:45', now.toLocaleTimeString(), now.toLocaleDateString()].join(' | '),
    );
  });

  test('refuses malformed historical date/time options before expanding instructions', () => {
    expect(() =>
      replaceRuntimeTemplateVariables('Meeting: {{meeting}}', {
        defaultModel: 'fixture',
        invokeModel: 'fixture',
        structureModel: 'fixture',
        templateVariables: [
          { key: 'meeting', type: 'time', format: '{"hour12":"false"}' },
        ],
      }),
    ).toThrow('Format for "meeting" must be a JSON object');
  });

  test('inserts a value that looks like a replacement pattern verbatim', () => {
    getCachedUser.mockReturnValue({
      alias: 'casey',
      name: "Casey $' Example",
      email: 'casey@example.com',
      title: 'Founder',
    });

    const result = replaceRuntimeTemplateVariables(
      'Name: {{user_name}} | Budget: {{budget}} | Echo: {{echo}} | tail',
      {
        region: 'us-west-2',
        defaultModel: 'claude-sonnet',
        invokeModel: 'claude-sonnet',
        structureModel: 'claude-sonnet',
        templateVariables: [
          { key: 'budget', type: 'static', value: '$$100' },
          { key: 'echo', type: 'static', value: '$& and $`' },
        ],
      },
    );

    expect(result).toBe(
      "Name: Casey $' Example | Budget: $$100 | Echo: $& and $` | tail",
    );
  });

  test('falls back cleanly when auth identity is unavailable', () => {
    getCachedUser.mockImplementation(() => {
      throw new Error('auth unavailable');
    });
    const logs = captureLoggerLines('debug');

    const result = replaceRuntimeTemplateVariables(
      'Alias={{user_alias}}; Date={{iso_date}}',
      {
        region: 'us-west-2',
        defaultModel: 'claude-sonnet',
        invokeModel: 'claude-sonnet',
        structureModel: 'claude-sonnet',
      },
    );

    expect(result).toContain('Alias={{user_alias}}');
    expect(result).toContain('Date=');
    expect(logs.at('debug').map((line) => line.msg)).toContain(
      'Auth module not loaded yet',
    );
  });
});
