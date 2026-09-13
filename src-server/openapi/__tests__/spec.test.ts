import { describe, expect, test } from 'vitest';
import { buildOpenApiSpec } from '../spec.js';

describe('buildOpenApiSpec', () => {
  test('every local schema reference resolves in the generated document', () => {
    const spec = buildOpenApiSpec();
    const unresolved: string[] = [];
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (
          key === '$ref' &&
          typeof child === 'string' &&
          child.startsWith('#/')
        ) {
          let target: unknown = spec;
          for (const encoded of child.slice(2).split('/')) {
            const part = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
            target =
              target && typeof target === 'object'
                ? (target as Record<string, unknown>)[part]
                : undefined;
          }
          if (target === undefined) unresolved.push(child);
        } else visit(child);
      }
    };
    visit(spec);
    expect(unresolved).toEqual([]);
  });

  test('describes retained recovery with required fresh consent and pending responses', () => {
    const spec = buildOpenApiSpec();
    expect(
      spec.paths['/api/plugins/{name}/recovery-preview']!.get!.responses,
    ).toHaveProperty('409');
    const recovery = spec.paths['/api/plugins/{name}/recover']!.post!;
    expect(recovery.requestBody!.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/PluginRecovery',
    );
    expect(Object.keys(recovery.responses)).toEqual(
      expect.arrayContaining(['202', '409', '503']),
    );
    const schema = spec.components.schemas.PluginRecovery as {
      required: string[];
      properties: { consent: { required: string[] } };
    };
    expect(schema.required).toEqual(
      expect.arrayContaining(['recoveryRevision', 'consent']),
    );
    expect(schema.properties.consent.required).toContain('grantRevision');
  });

  test('includes the first-pass portability route set', () => {
    const spec = buildOpenApiSpec();

    expect(spec.openapi).toBe('3.1.0');
    expect(spec.paths['/config/app']).toBeDefined();
    expect(spec.paths['/agents']).toBeDefined();
    expect(spec.paths['/integrations']).toBeDefined();
    expect(spec.paths['/api/playbooks']).toBeUndefined();
    expect(spec.paths['/api/registry/plugins']).toBeDefined();
    expect(spec.paths['/api/plugins']).toBeDefined();
  });

  test('includes request schemas for mutating operations', () => {
    const spec = buildOpenApiSpec();

    expect(
      spec.paths['/config/app']!.put!.requestBody!.content['application/json']
        .schema.$ref,
    ).toBe('#/components/schemas/AppConfigUpdate');
    expect(
      spec.paths['/integrations/{id}']!.put!.requestBody!.content[
        'application/json'
      ].schema.$ref,
    ).toBe('#/components/schemas/IntegrationUpdate');
    expect(
      spec.paths['/api/plugins/install']!.post!.requestBody!.content[
        'application/json'
      ].schema.$ref,
    ).toBe('#/components/schemas/PluginInstall');
    expect(spec.components.schemas.IntegrationUpdate).toBeDefined();
    expect(spec.components.schemas.PlaybookOutcome).toBeUndefined();
  });

  test('describes the skills routes, including command/variables and usage', () => {
    const spec = buildOpenApiSpec();

    expect(spec.paths['/api/skills']).toBeDefined();
    expect(
      spec.paths['/api/skills/{name}']!.put!.requestBody!.content[
        'application/json'
      ].schema.$ref,
    ).toBe('#/components/schemas/SkillUpdate');
    expect(spec.paths['/api/skills/{name}/run']!.post).toBeDefined();
    expect(
      spec.paths['/api/skills/{name}/outcome']!.post!.requestBody!.content[
        'application/json'
      ].schema.$ref,
    ).toBe('#/components/schemas/SkillOutcome');
    expect(
      spec.paths['/api/skills/import']!.post!.requestBody!.content[
        'application/json'
      ].schema.$ref,
    ).toBe('#/components/schemas/SkillImport');
    // The declaration is described, not just referenced by name.
    expect(JSON.stringify(spec.components.schemas.SkillUpdate)).toContain(
      'enabled',
    );
  });

  test('documents the statuses the skills routes actually answer with', () => {
    const spec = buildOpenApiSpec();

    expect(
      Object.keys(spec.paths['/api/skills/{name}']!.put!.responses),
    ).toContain('409');
    expect(
      Object.keys(spec.paths['/api/skills/import']!.post!.responses),
    ).toEqual(expect.arrayContaining(['201', '207']));
    expect(
      Object.keys(spec.paths['/api/skills/{name}/run']!.post!.responses),
    ).toEqual(expect.arrayContaining(['404', '503']));
  });

  test('every templated path declares its required path parameters', () => {
    const spec = buildOpenApiSpec();

    const missing = Object.entries(spec.paths)
      .filter(([path]) => path.includes('{'))
      .filter(([path, item]) => {
        const expected = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
        const declared = (
          (item as { parameters?: Array<{ name: string }> }).parameters ?? []
        ).map((parameter) => parameter.name);
        return expected.some((name) => !declared.includes(name));
      })
      .map(([path]) => path);

    expect(missing).toEqual([]);
    expect(spec.paths['/api/skills/{name}'].parameters).toEqual([
      { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  });
});
