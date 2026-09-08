import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { manifestWithStationNetworkPolicy } from '../apply-android-network-policy.mjs';

describe('generated Android network policy', () => {
  // The second value is an Android manifest placeholder, not JavaScript.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Gradle placeholder
  test.each(['false', '${usesCleartextTraffic}'])(
    'repairs generated %s and preserves the rest of the manifest',
    (value) => {
      const source = `<manifest><application android:label="Station" android:usesCleartextTraffic="${value}"><activity /></application></manifest>`;
      const result = manifestWithStationNetworkPolicy(source);
      expect(result).toBe(
        '<manifest><application android:label="Station" android:usesCleartextTraffic="true"><activity /></application></manifest>',
      );
      expect(manifestWithStationNetworkPolicy(result)).toBe(result);
    },
  );
  test('adds missing policy and refuses ambiguous or overriding configuration', () => {
    expect(
      manifestWithStationNetworkPolicy('<manifest><application /></manifest>'),
    ).toBe(
      '<manifest><application android:usesCleartextTraffic="true" /></manifest>',
    );
    expect(() => manifestWithStationNetworkPolicy('<manifest />')).toThrow();
    expect(() =>
      manifestWithStationNetworkPolicy('<application /><application />'),
    ).toThrow();
    expect(() =>
      manifestWithStationNetworkPolicy(
        '<application android:networkSecurityConfig="@xml/network" />',
      ),
    ).toThrow();
  });
  test.each(['build-android.yml', 'nightly-native-stage.yml', 'release.yml'])(
    '%s reapplies policy after generation',
    (name) => {
      const source = readFileSync(
        new URL(`../../.github/workflows/${name}`, import.meta.url),
        'utf8',
      );
      const init = source.indexOf('tauri android init');
      const policy = source.indexOf(
        'node scripts/apply-android-network-policy.mjs',
      );
      expect(init).toBeGreaterThan(-1);
      expect(policy).toBeGreaterThan(init);
      expect(source.indexOf('tauri android build', policy)).toBeGreaterThan(
        policy,
      );
    },
  );
});
