#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from './lib/release-sboms.mjs';
import { containerSourceToFragment } from './release-container-sbom-source.mjs';

function option(name, args) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`);
  return args[index + 1];
}

export function normalizeCargoPurl(purl) {
  if (typeof purl !== 'string' || !purl.startsWith('pkg:cargo/'))
    throw new Error('cargo component has an invalid package URL');
  const hashIndex = purl.indexOf('#');
  const withoutFragment = hashIndex < 0 ? purl : purl.slice(0, hashIndex);
  const fragment = hashIndex < 0 ? '' : purl.slice(hashIndex);
  const question = withoutFragment.indexOf('?');
  if (question < 0) return purl;
  const base = withoutFragment.slice(0, question);
  const qualifiers = withoutFragment.slice(question + 1).split('&');
  if (qualifiers.some((qualifier) => qualifier.length === 0))
    throw new Error('cargo component has malformed package URL qualifiers');
  const retained = [];
  for (const qualifier of qualifiers) {
    const separator = qualifier.indexOf('=');
    if (separator <= 0)
      throw new Error('cargo component has malformed package URL qualifiers');
    let key, value;
    try {
      key = decodeURIComponent(qualifier.slice(0, separator));
      value = decodeURIComponent(qualifier.slice(separator + 1));
    } catch {
      throw new Error('cargo component has malformed package URL qualifiers');
    }
    if (key !== 'download_url') {
      retained.push(qualifier);
      continue;
    }
    let local;
    try {
      local = new URL(value);
    } catch {
      throw new Error('cargo component has malformed local download URL');
    }
    if (local.protocol !== 'file:')
      throw new Error('cargo component has a non-file local download URL');
  }
  retained.sort((left, right) => left.localeCompare(right));
  return `${base}${retained.length ? `?${retained.join('&')}` : ''}${fragment}`;
}

export function cyclonedxComponents(input, ecosystem, source = 'input') {
  if (
    input?.bomFormat !== 'CycloneDX' ||
    !(ecosystem === 'cargo'
      ? ['1.3', '1.4', '1.5'].includes(input?.specVersion)
      : input?.specVersion === '1.6') ||
    !Array.isArray(input.components)
  )
    throw new Error(
      `${source} is not a supported ${ecosystem} CycloneDX inventory`,
    );
  return input.components.map((component) => {
    if (
      typeof component?.name !== 'string' ||
      typeof component?.version !== 'string' ||
      typeof component?.purl !== 'string'
    )
      throw new Error(`${source} has an incomplete component identity`);
    if (!component.purl.startsWith(`pkg:${ecosystem}/`))
      throw new Error(`${source} has a mismatched ${ecosystem} component`);
    const group = component.group;
    if (
      group !== undefined &&
      (typeof group !== 'string' || group.length === 0 || group.length > 160)
    )
      throw new Error(`${source} has an invalid component group`);
    const hashes = component.hashes?.filter(
      (hash) =>
        (hash?.alg === 'SHA-256' && /^[a-f0-9]{64}$/.test(hash.content)) ||
        (hash?.alg === 'SHA-512' && /^[a-f0-9]{128}$/.test(hash.content)),
    );
    const licenses = component.licenses
      ?.map((item) => item?.license?.id)
      .filter((id) => typeof id === 'string');
    return {
      // cyclonedx-npm expresses scoped names as group + name while PURLs
      // encode the complete npm identity. Keep the two representations bound.
      name:
        ecosystem === 'npm' && group
          ? `${group}/${component.name}`
          : component.name,
      version: component.version,
      purl:
        ecosystem === 'cargo'
          ? normalizeCargoPurl(component.purl)
          : component.purl,
      ...(hashes?.length ? { hashes } : {}),
      ...(licenses?.length ? { licenses } : {}),
      ...(component.properties?.some(
        (property) => property?.name === 'station:pnpm-patch-hash',
      )
        ? {
            properties: component.properties.filter(
              (property) => property?.name === 'station:pnpm-patch-hash',
            ),
          }
        : {}),
    };
  });
}

function components(file, ecosystem) {
  return cyclonedxComponents(
    JSON.parse(readFileSync(file, 'utf8')),
    ecosystem,
    file,
  );
}

function containerFragment(args) {
  const source = JSON.parse(
    readFileSync(option('--container-source', args), 'utf8'),
  );
  const descriptor = JSON.parse(
    readFileSync(option('--container-descriptor', args), 'utf8'),
  );
  return containerSourceToFragment({
    source,
    descriptor,
    sourceSha: option('--source-sha', args),
  });
}

export function runReleaseSbomFragments(args) {
  const output = resolve(option('--output-dir', args));
  mkdirSync(output, { recursive: true });
  const entries = [
    ['npm', 'runtime', option('--npm-cyclonedx', args), 'npm.fragment.json'],
    ['rust', 'native', option('--rust-cyclonedx', args), 'rust.fragment.json'],
  ];
  for (const [source, predicate, input, name] of entries)
    writeFileSync(
      resolve(output, name),
      canonicalJson({
        source,
        predicate,
        // The final release documents are 1.6. cargo-cyclonedx 0.5.9 emits a
        // supported historical producer format, so normalize only its package
        // identities here rather than pretending that its source is 1.6.
        components: components(input, source === 'npm' ? 'npm' : 'cargo'),
      }),
    );
  writeFileSync(
    resolve(output, 'container.fragment.json'),
    canonicalJson(containerFragment(args)),
  );
}

// This module is intentionally inert when imported by converter/process tests.
// The entry comparison evaluates argv only in an executable Node entrypoint.
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    runReleaseSbomFragments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
