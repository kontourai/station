import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

type WireVariant = {
  required: string[];
  optional: string[];
};

function lowerCamel(value: string): string {
  return `${value.slice(0, 1).toLowerCase()}${value.slice(1)}`;
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

function enumBody(source: string, name: string): string {
  const declaration = source.indexOf(`enum ${name}`);
  if (declaration < 0) throw new Error(`Rust enum not found: ${name}`);
  const serde = source.slice(Math.max(0, declaration - 240), declaration);
  if (!serde.includes('#[serde(rename_all = "camelCase", tag = "status")]')) {
    throw new Error(`${name} must retain its camelCase tagged serde contract.`);
  }
  const start = source.indexOf('{', declaration);
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start + 1, index);
  }
  throw new Error(`Rust enum is not balanced: ${name}`);
}

function rustWireSchema(
  source: string,
  name: string,
): Record<string, WireVariant> {
  const body = enumBody(source, name);
  const schema: Record<string, WireVariant> = {};
  const variantPattern = /\b([A-Z][A-Za-z0-9_]*)\s*\{([\s\S]*?)\n\s*\},/g;
  for (const match of body.matchAll(variantPattern)) {
    const variant = lowerCamel(match[1]);
    const fields = match[2].replaceAll(/#\[serde\([^\]]+\)\]\s*/g, '');
    const wire: WireVariant = { required: [], optional: [] };
    for (const field of fields.matchAll(
      /\b([a-z][a-z0-9_]*)\s*:\s*([^,]+),/g,
    )) {
      const key = snakeToCamel(field[1]);
      const target = field[2].includes('Option<')
        ? wire.optional
        : wire.required;
      target.push(key);
    }
    schema[variant] = wire;
  }
  return schema;
}

function typeScriptWireSchema(
  source: string,
  name: string,
): Record<string, WireVariant> {
  const file = ts.createSourceFile(
    'types.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = file.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
  );
  if (!declaration || !ts.isUnionTypeNode(declaration.type)) {
    throw new Error(`TypeScript wire union not found: ${name}`);
  }
  const schema: Record<string, WireVariant> = {};
  for (const member of declaration.type.types) {
    if (!ts.isTypeLiteralNode(member)) {
      throw new Error(`${name} members must remain object literals.`);
    }
    const status = member.members.find(
      (field): field is ts.PropertySignature =>
        ts.isPropertySignature(field) && field.name.getText(file) === 'status',
    );
    if (
      !status?.type ||
      !ts.isLiteralTypeNode(status.type) ||
      !ts.isStringLiteral(status.type.literal)
    ) {
      throw new Error(
        `${name} must retain a string-literal status discriminator.`,
      );
    }
    const wire: WireVariant = { required: [], optional: [] };
    for (const field of member.members) {
      if (!ts.isPropertySignature(field)) continue;
      const key = field.name.getText(file);
      if (key === 'status') continue;
      (field.questionToken ? wire.optional : wire.required).push(key);
    }
    schema[status.type.literal.text] = wire;
  }
  return schema;
}

describe('native Browser Preview wire contract', () => {
  test('keeps TypeScript fixtures aligned with Rust serde variants and fields', () => {
    const rust = readFileSync(
      new URL('../../../../../src-desktop/src/lib.rs', import.meta.url),
      'utf8',
    );
    const typeScript = readFileSync(
      new URL('../types.ts', import.meta.url),
      'utf8',
    );

    for (const name of [
      'NativeBrowserPreviewWindowResponse',
      'NativeBrowserPreviewGrantResponse',
    ]) {
      expect(rustWireSchema(rust, name)).toEqual(
        typeScriptWireSchema(typeScript, name),
      );
    }
  });
});
