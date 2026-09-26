/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import ts from 'typescript';
import { afterEach, describe, expect, test, vi } from 'vitest';

const platform = vi.hoisted(() => ({ isTauri: false }));
const gateMounts = vi.hoisted(() => [] as string[]);

vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => platform,
}));
// The real gate probes `apiBase` for a device session. Recording its mounts is
// the observable: a gate that never mounts never probes.
vi.mock('../components/LocalUiSessionGate', () => ({
  LocalUiSessionGate: ({
    apiBase,
    children,
  }: {
    apiBase: string;
    children: React.ReactNode;
  }) => {
    gateMounts.push(apiBase);
    return <div data-testid="local-ui-session-gate">{children}</div>;
  },
}));

import { PlatformSessionGate } from '../platform/PlatformSessionGate';

afterEach(() => {
  cleanup();
  gateMounts.length = 0;
});

describe('LocalUiSessionGate native shell boundary', () => {
  test('never probes tauri://localhost as though it were an HTTP Station', () => {
    platform.isTauri = true;
    render(
      <PlatformSessionGate apiBase="tauri://localhost">
        <p>protected tree</p>
      </PlatformSessionGate>,
    );

    expect(screen.getByText('protected tree')).toBeTruthy();
    expect(screen.queryByTestId('local-ui-session-gate')).toBeNull();
    expect(gateMounts).toEqual([]);
  });

  test('the web client mounts the device-session gate for the given apiBase', () => {
    platform.isTauri = false;
    render(
      <PlatformSessionGate apiBase="http://station.test">
        <p>protected tree</p>
      </PlatformSessionGate>,
    );

    expect(screen.getByTestId('local-ui-session-gate').textContent).toContain(
      'protected tree',
    );
    expect(gateMounts).toEqual(['http://station.test']);
  });

  // main.tsx is the entrypoint and cannot be mounted here, so its composition
  // is read as syntax: the gate the tests above render must be the one the
  // entry wraps the protected tree in, bound to the local Station origin.
  test('main.tsx wraps the protected tree in PlatformSessionGate at the local Station origin', () => {
    const file = resolve(import.meta.dirname, '../main.tsx');
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const gates: ts.JsxElement[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isJsxElement(node) &&
        node.openingElement.tagName.getText(source) === 'PlatformSessionGate'
      )
        gates.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(gates).toHaveLength(1);
    const [gate] = gates;

    const apiBase = gate.openingElement.attributes.properties.find(
      (attribute): attribute is ts.JsxAttribute =>
        ts.isJsxAttribute(attribute) &&
        attribute.name.getText(source) === 'apiBase',
    );
    const value = apiBase?.initializer;
    expect(
      value &&
        ts.isJsxExpression(value) &&
        value.expression &&
        ts.isIdentifier(value.expression)
        ? value.expression.text
        : undefined,
    ).toBe('localUiApiBase');

    // The protected tree: the authority provider sits INSIDE the gate.
    const inside: string[] = [];
    const collect = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
        inside.push(node.tagName.getText(source));
      ts.forEachChild(node, collect);
    };
    for (const child of gate.children) collect(child);
    expect(inside).toContain('AuthorityQueryProvider');
    expect(inside).toContain('App');
  });

  test('waits for local access resolution before seeding web boot data', () => {
    const main = readFileSync(
      resolve(import.meta.dirname, '../main.tsx'),
      'utf8',
    );

    expect(main).not.toContain('hadBootstrapToken');
    // #2278 moved the boot fast path from main.tsx into the authority
    // provider's verified effect. The invariant survives the move: the
    // identity resolution happens first, seeding is gated on the
    // authenticated kind (and scope currency), and the seed follows both.
    const authority = readFileSync(
      resolve(import.meta.dirname, '../contexts/AuthorityQueryContext.tsx'),
      'utf8',
    );
    expect(authority).toContain(
      'const resolution = await resolveLocalUiSession(localUiApiBase);',
    );
    expect(authority).toContain("resolution.kind !== 'authenticated'");
    expect(authority).toContain('seedBootPayloadGuarded(');
    expect(
      authority.indexOf('const resolution = await resolveLocalUiSession'),
    ).toBeLessThan(authority.indexOf("resolution.kind !== 'authenticated'"));
    expect(
      authority.indexOf("resolution.kind !== 'authenticated'"),
    ).toBeLessThan(authority.indexOf('seedBootPayloadGuarded('));
  });
});
