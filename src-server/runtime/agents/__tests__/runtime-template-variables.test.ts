import { afterEach, describe, expect, test, vi } from 'vitest';

const getCachedUser = vi.fn(() => ({
  alias: 'brian',
  name: 'Brian Anderson',
  email: 'brian@example.com',
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
    vi.restoreAllMocks();
    getCachedUser.mockReturnValue({
      alias: 'brian',
      name: 'Brian Anderson',
      email: 'brian@example.com',
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
    expect(result).toBe('Hi brian on 2026-04-10');
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

    expect(result).toContain('Alias: brian');
    expect(result).toContain('Name: Brian Anderson');
    expect(result).toContain('Email: brian@example.com');
    expect(result).toContain('Title: Founder');
    expect(result).toContain('Project: Work Agent');
    expect(result).toContain('ISO: 2026-04-10');

    vi.useRealTimers();
  });

  test('falls back cleanly when auth identity is unavailable', () => {
    getCachedUser.mockImplementation(() => {
      throw new Error('auth unavailable');
    });
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

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
    expect(debugSpy).toHaveBeenCalled();
  });
});
