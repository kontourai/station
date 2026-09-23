import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const inventory = JSON.parse(
  readFileSync(join(process.cwd(), 'docs/ui/responsive-surfaces.json'), 'utf8'),
) as {
  surfaces: Array<{
    path: string;
    strategy: 'covered' | 'exception';
    contract?: string;
  }>;
};

const stationSurfaces = inventory.surfaces.filter((surface) =>
  surface.path.startsWith('src-ui/src/'),
);
const contractedSurfaces = stationSurfaces.filter(
  (surface) => surface.contract === 'ResponsiveDialogSurface',
);

describe('responsive dialog source contract', () => {
  test('leaves no Station-owned modal exception behind', () => {
    expect(
      stationSurfaces
        .filter((surface) => surface.strategy === 'exception')
        .map((surface) => surface.path),
    ).toEqual([]);
  });

  test.each(contractedSurfaces)(
    '$path adopts the shared dialog owner',
    ({ path }) => {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      expect(source).toContain('ResponsiveDialogSurface');
      expect(source).not.toMatch(/document\.addEventListener\(['"]keydown/);
    },
  );

  test('the plugin stack routes its inline surfaces through the contract', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'src-ui/src/views/plugin-management/PluginModalStack.tsx',
      ),
      'utf8',
    );
    // The installing card, and the person-confirmed remove and update
    // (#2323 S5: an update, like a remove, needs a person).
    expect(source.match(/<ResponsiveDialogSurface/g)).toHaveLength(3);
    expect(source).toContain('ariaLabel="Installing plugin"');
    expect(source).toContain('ariaLabelledBy="remove-plugin-title"');
    expect(source).toContain('ariaLabelledBy="update-plugin-title"');
    expect(source).toContain('layer="system"');
    expect(source).toContain('dismissible={false}');
  });
});
