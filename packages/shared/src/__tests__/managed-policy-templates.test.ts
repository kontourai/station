import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANAGED_POLICY_ENFORCED_LIMIT_KEYS } from '@kontourai/station-contracts/managed-policy';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  MANAGED_POLICY_CONTROLS,
  templateManagedPolicyControls,
  WINDOWS_POLICY_SUBKEY,
} from '../managed-policy-controls.js';
import {
  managedPolicyAdml,
  managedPolicyAdmx,
} from '../managed-policy-templates.js';

const makeTempDir = trackTempDirs();
const SCHEMA = join(
  import.meta.dirname,
  'fixtures',
  'admx-schema',
  'PolicyDefinitionFiles.xsd',
);
const XMLLINT = '/usr/bin/xmllint';

function validate(
  name: string,
  content: string,
): { status: number | null; output: string } {
  const dir = makeTempDir('station-admx-');
  const file = join(dir, name);
  writeFileSync(file, content);
  const result = spawnSync(XMLLINT, ['--noout', '--schema', SCHEMA, file], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('the Group Policy template', () => {
  const admx = managedPolicyAdmx();
  const adml = managedPolicyAdml();

  test.skipIf(!existsSync(XMLLINT))(
    'station.admx and station.adml validate against the ADMX schema',
    () => {
      expect(validate('station.admx', admx)).toEqual({
        status: 0,
        output: expect.stringContaining('validates'),
      });
      expect(validate('station.adml', adml)).toEqual({
        status: 0,
        output: expect.stringContaining('validates'),
      });
    },
  );

  test.skipIf(!existsSync(XMLLINT))(
    'the schema check rejects a broken template (it is not vacuous)',
    () => {
      const broken = admx.replace('<parentCategory', '<parentCategoryX');
      const result = validate('broken.admx', broken);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('parentCategoryX');
    },
  );

  test('every policy sits in the Station category under the policy key, for the machine', () => {
    const policies = [
      ...admx.matchAll(
        /<policy name="([^"]+)" class="([^"]+)"[^>]*key="([^"]+)"/g,
      ),
    ];
    expect(policies.length).toBe(templateManagedPolicyControls().length);
    for (const [, , klass, key] of policies) {
      expect(klass).toBe('Machine');
      expect(key).toBe(WINDOWS_POLICY_SUBKEY);
    }
    expect(admx).toContain(
      '<category name="Station" displayName="$(string.Station)" />',
    );
    expect(admx.match(/<parentCategory ref="Station" \/>/g)?.length).toBe(
      policies.length,
    );
  });

  test('every string and presentation the ADMX references is in the ADML', () => {
    const strings = new Set(
      [...adml.matchAll(/<string id="([^"]+)">/g)].map((m) => m[1]),
    );
    for (const [, id] of admx.matchAll(/\$\(string\.([^)]+)\)/g))
      expect(strings.has(id), id).toBe(true);
    const presentations = new Set(
      [...adml.matchAll(/<presentation id="([^"]+)">/g)].map((m) => m[1]),
    );
    for (const [, id] of admx.matchAll(/\$\(presentation\.([^)]+)\)/g))
      expect(presentations.has(id), id).toBe(true);
    const elementIds = new Set(
      [...admx.matchAll(/<(?:text|multiText|enum|boolean) id="([^"]+)"/g)].map(
        (m) => m[1],
      ),
    );
    for (const [, refId] of adml.matchAll(/refId="([^"]+)"/g))
      expect(elementIds.has(refId), refId).toBe(true);
  });

  test('every enforced limit has a policy in the generated ADMX', () => {
    for (const limit of MANAGED_POLICY_ENFORCED_LIMIT_KEYS) {
      const ids = MANAGED_POLICY_CONTROLS.filter(
        (control) => control.limitKey === limit,
      ).map((control) => control.id);
      expect(ids.length, limit).toBeGreaterThan(0);
      for (const id of ids)
        expect(admx, `${limit} → ${id}`).toContain(`<policy name="${id}"`);
    }
  });

  test('an "Allow" switch writes 1 for Enabled and 0 for Disabled', () => {
    expect(admx).toMatch(
      /<policy name="Telemetry"[^>]*valueName="Telemetry">\s*<parentCategory ref="Station" \/>\s*<supportedOn ref="SUPPORTED_Station" \/>\s*<enabledValue><decimal value="1" \/><\/enabledValue>\s*<disabledValue><decimal value="0" \/><\/disabledValue>/,
    );
  });

  test('a policy whose Disabled state is refused writes its own state value', () => {
    expect(admx).toMatch(
      /<policy name="RegistryAllowList"[^>]*valueName="RegistryAllowList" presentation="\$\(presentation\.RegistryAllowList\)">[\s\S]*?<disabledValue><decimal value="0" \/><\/disabledValue>[\s\S]*?<multiText id="RegistryAllowedUrls" valueName="RegistryAllowedUrls"/,
    );
  });
});
