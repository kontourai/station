import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  createContainerReleaseDescriptor,
  createContainerReleaseMetadata,
  createPackagedReleaseManifest,
} from '../lib/container-release-metadata.mjs';

const root = resolve(import.meta.dirname, '../..');
const sha = 'a'.repeat(40);
const createdAt = '2026-07-23T05:50:00.000Z';

function dockerStage(dockerfile: string, name: string): string {
  const lines = dockerfile.split('\n');
  const starts: { name: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^FROM\s+\S+\s+AS\s+(\S+)/i);
    if (match) starts.push({ name: match[1], line: i });
  }
  const idx = starts.findIndex((stage) => stage.name === name);
  if (idx === -1) return '';
  const begin = starts[idx].line;
  const end = idx + 1 < starts.length ? starts[idx + 1].line : lines.length;
  return lines.slice(begin, end).join('\n');
}

function dockerContextIncludes(ignore: string, path: string): boolean {
  let included = true;
  for (const raw of ignore.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    const pattern = negated ? line.slice(1) : line;
    const escaped = pattern
      .replaceAll('**', '\u0000')
      .replace(/[.+^${}()|\\]/g, '\\$&')
      .replaceAll('*', '[^/]*')
      .replaceAll('\u0000', '.*');
    const regex = new RegExp(
      `^${escaped}${pattern.endsWith('/') ? '.*' : ''}$`,
    );
    if (regex.test(path)) included = negated;
  }
  return included;
}

// Parse every COPY directive's source paths from a Dockerfile stage. Handles
// both Docker COPY forms — shell `COPY [--flag ...] src [src ...] dest` and
// JSON `COPY [--flag ...] ["src", ..., "dest"]` — and fails closed: any COPY
// it cannot fully parse throws instead of being silently skipped. The prior
// loose regex plus `continue` on single-token lines mis-tokenized JSON-form
// COPY and skipped malformed lines, so `/app/.`, `/app/*`, `./.`, and
// `COPY ["/app", "./"]` all slipped through unflagged. Line continuations
// (`\` at end of line) are joined first so a multi-line COPY is one directive.
function parseCopySources(stage: string): string[] {
  const sources: string[] = [];
  const joined = stage.replace(/\\\n\s*/g, ' ');
  for (const rawLine of joined.split('\n')) {
    const match = rawLine.match(/^\s*COPY\b\s*(.*)$/i);
    if (!match) continue;
    let rest = match[1];
    while (/^--\S+\s*/.test(rest)) {
      rest = rest.replace(/^--\S+\s*/, '');
    }
    rest = rest.trim();
    if (rest.length === 0) {
      throw new Error(
        `Malformed COPY (no source/destination): ${rawLine.trim()}`,
      );
    }
    let args: string[];
    if (rest.startsWith('[')) {
      const end = rest.lastIndexOf(']');
      if (end === -1) {
        throw new Error(`Malformed JSON COPY (missing "]"): ${rawLine.trim()}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rest.slice(0, end + 1));
      } catch {
        throw new Error(
          `Malformed JSON COPY (invalid JSON): ${rawLine.trim()}`,
        );
      }
      if (
        !Array.isArray(parsed) ||
        parsed.length < 2 ||
        !parsed.every((item) => typeof item === 'string')
      ) {
        throw new Error(
          `Malformed JSON COPY (need array of >=2 strings): ${rawLine.trim()}`,
        );
      }
      args = parsed;
    } else {
      args = rest.split(/\s+/).filter(Boolean);
      if (args.length < 2) {
        throw new Error(
          `Malformed COPY (need >=1 source and a destination): ${rawLine.trim()}`,
        );
      }
    }
    sources.push(...args.slice(0, -1));
  }
  return sources;
}

// A COPY source is "broad" if it carries the whole build context, the build
// root, the entire /app workspace, or any src-desktop tree — all of which
// carry src-desktop/tauri.conf.json transitively and so false-green a literal
// "tauri.conf.json" absence check. Glob metacharacters and redundant "."
// segments are normalized away first so semantically-broad variants reduce to
// a broad root: /app/. , /app/./ , /app/* , /app/ -> /app ; ./. , ./* , ./ -> .
// The `(?=\/|$)` lookahead on the dot-stripper protects dotfile segments such
// as /app/.station-release.json (its leading "." is followed by a name, not a
// slash or end), so legitimate sources are not mis-flagged as broad.
function isBroadCopySource(src: string): boolean {
  if (/(^|\/)src-desktop(\/|$)/.test(src)) return true;
  let s = src.replace(/[*?[\]]/g, '');
  s = s.replace(/\/+/g, '/');
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(/\/\.(?=\/|$)/g, '');
    if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  }
  return s === '.' || s === '/' || s === '/app';
}

// The runtime stage's exact allowlisted COPY sources. Any addition (broad or
// not) fails the contract test until this set is consciously updated — that is
// the gate: a broad source like /app or . cannot sneak in unnoticed.
const ALLOWED_RUNTIME_COPY_SOURCES = new Set([
  '/app/node_modules',
  '/app/package.json',
  '/app/package-lock.json',
  '/app/station',
  '/app/.station-release.json',
  '/app/packages',
  '/app/src-server',
  '/app/src-shared',
  '/app/schemas',
  '/app/scripts',
  '/app/config',
  '/app/examples',
  '/app/dist-server-container',
  '/app/dist-ui-container',
]);

describe('container release metadata', () => {
  test('derives stable immutable tags and OCI labels', () => {
    expect(
      createContainerReleaseMetadata({
        tag: 'v1.2.3',
        sha,
        createdAt,
        repository: 'kontourai/station',
      }),
    ).toEqual(
      expect.objectContaining({
        channel: 'stable',
        tags: [`v1.2.3`, '1.2.3', `sha-${sha}`, 'latest'],
        labels: expect.objectContaining({
          'org.opencontainers.image.revision': sha,
          'org.opencontainers.image.version': 'v1.2.3',
        }),
      }),
    );
  });

  test('derives preview rather than latest channel tags', () => {
    expect(
      createContainerReleaseMetadata({
        tag: 'v1.2.3-preview.4',
        sha,
        createdAt,
        repository: 'kontourai/station',
      }),
    ).toMatchObject({
      channel: 'preview',
      tags: ['v1.2.3-preview.4', '1.2.3-preview.4', `sha-${sha}`, 'preview'],
    });
  });

  test('derives the strict Station packaged-release manifest from the same parser', () => {
    expect(
      createPackagedReleaseManifest({
        tag: 'v1.2.3-preview.4',
        sha,
        createdAt,
      }),
    ).toEqual({
      schemaVersion: 1,
      sha,
      ref: 'v1.2.3-preview.4',
      createdAt,
      channel: 'preview',
      prerelease: true,
    });
  });

  test('binds immutable digest promotion to the same release metadata', () => {
    const metadata = createContainerReleaseMetadata({
      tag: 'v1.2.3-preview.4',
      sha,
      createdAt,
      repository: 'kontourai/station',
    });
    expect(
      createContainerReleaseDescriptor({
        metadata,
        digest: `sha256:${'b'.repeat(64)}`,
      }),
    ).toEqual({
      image: 'ghcr.io/kontourai/station',
      digest: `sha256:${'b'.repeat(64)}`,
      sha,
      tag: 'v1.2.3-preview.4',
      createdAt,
      platforms: ['linux/amd64', 'linux/arm64'],
      tags: ['v1.2.3-preview.4', '1.2.3-preview.4', `sha-${sha}`, 'preview'],
    });
  });

  test.each(['sha256:short', `sha512:${'b'.repeat(64)}`, undefined])(
    'rejects malformed immutable digest %s',
    (digest) => {
      const metadata = createContainerReleaseMetadata({
        tag: 'v1.2.3',
        sha,
        createdAt,
        repository: 'kontourai/station',
      });
      expect(() =>
        createContainerReleaseDescriptor({ metadata, digest }),
      ).toThrow('Invalid container release metadata');
    },
  );

  test.each([
    { tag: 'v01.2.3', sha, createdAt, repository: 'kontourai/station' },
    { tag: 'v1.2.3', sha: 'short', createdAt, repository: 'kontourai/station' },
    {
      tag: 'v1.2.3',
      sha,
      createdAt: '2026-07-23',
      repository: 'kontourai/station',
    },
    {
      tag: 'v1.2.3',
      sha,
      createdAt: 'not-a-date',
      repository: 'kontourai/station',
    },
    { tag: 'v1.2.3', sha, createdAt, repository: 'Kontourai/Station' },
  ])('rejects malformed release provenance %#', (input) => {
    expect(() => createContainerReleaseMetadata(input)).toThrow(
      'Invalid container release metadata',
    );
  });
});

describe('container source contract', () => {
  const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');
  const compose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');
  const release = readFileSync(
    resolve(root, '.github/workflows/release.yml'),
    'utf8',
  );
  const publishRelease = readFileSync(
    resolve(root, '.github/workflows/publish-release.yml'),
    'utf8',
  );
  const smokeWorkflow = readFileSync(
    resolve(root, '.github/workflows/container-smoke.yml'),
    'utf8',
  );
  const smoke = readFileSync(
    resolve(root, 'scripts/container-smoke.sh'),
    'utf8',
  );
  const deployment = readFileSync(
    resolve(root, 'docs/guides/deployment.md'),
    'utf8',
  );
  const ignore = readFileSync(resolve(root, '.dockerignore'), 'utf8');

  test('keeps one non-root same-origin lifecycle container with durable mounts', () => {
    const runtimeStage = dockerfile.split(' AS runtime')[1];
    expect(dockerfile).toContain('FROM node:24-slim');
    expect(dockerfile).toContain('node:24-slim@sha256:');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('tini');
    expect(dockerfile).toContain('service", "run"');
    expect(dockerfile).toContain('.station-release.json');
    expect(dockerfile).toContain('__station/identity');
    expect(dockerfile).toContain('STATION_IMAGE_SHA');
    expect(dockerfile).toContain('STATION_HOME=/data/station');
    expect(dockerfile).toContain(
      'mkdir -p /app/.station /data/station /workspace',
    );
    expect(dockerfile).toContain(
      'chown -R node:node /app/.station /data /workspace',
    );
    expect(dockerfile).not.toContain('COPY . .');
    expect(dockerfile).not.toContain('/app /app');
    expect(dockerfile).toContain('g++ make python3');
    const workspaces = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ).workspaces as string[];
    for (const workspace of workspaces)
      expect(dockerfile).toContain(
        `COPY ${workspace}/package.json ${workspace}/`,
      );
    for (const lock of [
      'packages/sdk/package-lock.json',
      'packages/shared/package-lock.json',
      'schemas/dependency-lifecycle-allowlist.schema.json',
    ])
      expect(dockerfile).toContain(`COPY ${lock}`);
    expect(dockerfile).toMatch(
      /COPY scripts\/node-runtime-contract\.mjs scripts\/dependency-lifecycle\.mjs scripts\/\s+COPY scripts\/lib\/dependency-lifecycle-policy\.mjs scripts\/lib\/\s+RUN npm run dependencies:ci/,
    );
    expect(runtimeStage).not.toContain('g++ make python3');
    // Runtime dependencies must come from the manifest-only install stage.
    // `build` inherits that stage but is invalidated by every source COPY, so
    // copying node_modules from it turns a source-only change into an
    // expensive recursive runtime-layer rebuild.
    expect(runtimeStage).toContain(
      'COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules',
    );
    expect(runtimeStage).not.toContain(
      'COPY --from=build --chown=node:node /app/node_modules ./node_modules',
    );
    // Release identity changes every build. Declare it only after the heavy
    // dependency copy so source-only release builds can reuse that layer.
    expect(runtimeStage.indexOf('ARG STATION_RELEASE_SHA')).toBeGreaterThan(
      runtimeStage.indexOf(
        'COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules',
      ),
    );
    expect(compose).toContain('station:');
    expect(compose).not.toContain('\n  server:');
    expect(compose).not.toContain('\n  ui:');
    expect(compose).not.toContain('build:');
    expect(compose).toContain('127.0.0.1');
    expect(compose).toContain(
      'ALLOWED_ORIGINS: $' + '{STATION_ALLOWED_ORIGINS:-}',
    );
    expect(compose).toContain('station-workspace');
    expect(compose).toContain('/data/station');
    expect(compose).toContain(':/workspace');
    expect(compose).not.toContain('env_file:');
    expect(ignore).toMatch(/^\*$/m);
    expect(ignore).not.toContain('!.git');
    expect(ignore).not.toContain('!.env');
    expect(ignore).not.toContain('!.station');
    expect(ignore).not.toContain('!.ssh');
    expect(ignore).toContain('**/__tests__/**');
    expect(ignore).toContain('**/fixtures/**');
    expect(ignore).toContain('**/*.pem');
  });

  test('binds release publication and smoke to immutable provenance and cleanup', () => {
    expect(release).toContain('needs: preflight');
    expect(release).toContain(
      'needs: [preflight, desktop-macos, desktop-windows, desktop-linux, portable, android, ios-simulator, ios-device, container]',
    );
    expect(release).toContain('packages: write');
    expect(release).toContain('linux/amd64,linux/arm64');
    expect(release).toContain('provenance: mode=max');
    expect(release).toContain('sbom: true');
    expect(release).toContain('container-release-metadata.mjs');
    expect(release).toContain(
      'Refuse to overwrite immutable source image staging',
    );
    expect(release).toContain('group: station-release-$' + '{{ github.ref }}');
    expect(release).toContain('station-container-release.json');
    expect(publishRelease).toContain(
      'Resolve draft tag to one immutable commit',
    );
    expect(publishRelease).toContain(
      'Promote only the recorded immutable GHCR digest',
    );
    expect(publishRelease).toContain('environment: native-release-publish');
    expect(smokeWorkflow).toContain('scripts/container-smoke.sh');
    expect(smoke).toContain('trap cleanup EXIT HUP INT TERM');
    expect(smoke).toContain('docker compose');
    expect(smoke).not.toContain('COMPOSE_PROJECT_NAME=${');
    expect(smoke).not.toContain('down --volumes');
    expect(smoke).toContain('randomBytes(12)');
    expect(smoke).toContain("printf 'v0.0.0-preview.1'");
    expect(smoke).toContain('Number.isFinite(epochSeconds)');
    expect(smoke).not.toContain('/^\\\\d+$/');
    expect(smoke).toContain('com.docker.compose.project');
    expect(smoke).toContain('remaining_resources');
    expect(smoke).toContain(
      'station-container-smoke:$' + '{SHA}-$' + '{RUN_TOKEN}',
    );
    expect(smoke).toContain(
      'com.kontourai.station.container-smoke=$COMPOSE_PROJECT_NAME',
    );
    expect(smoke).toContain('docker image rm "$STATION_IMAGE"');
    expect(smoke).toContain('refusing to remove unowned smoke image');
    expect(smoke).toContain('runtime image contains application test');
    expect(smoke).toContain('-path "*/node_modules/*" -prune');
    expect(smoke).toContain('runtime image contains application private-key');
    expect(smoke).toContain('STATION_CONTAINER_HOST_CREDENTIAL');
    expect(smoke).toContain('build_log="$WORKSPACE/docker-build.log"');
    expect(smoke).toContain('docker build --pull --progress=plain');
    expect(smoke).toContain('cat "$build_log" >&2');
    expect(smoke).toContain('container image build failed');
    expect(smoke).toContain(
      '"http://127.0.0.1:$' + '{STATION_UI_PORT}/api/system/identity"',
    );
    expect(smoke).toContain('authenticated Station API did not become ready');
    expect(smoke).toContain(
      'authenticated Station API did not recover after restart',
    );
    expect(smoke).toContain('chmod 0755 "$WORKSPACE"');
    expect(smoke).toContain(
      'STATION_ALLOWED_ORIGINS="http://127.0.0.1:$' + '{STATION_UI_PORT}"',
    );
    expect(smoke).toContain('container-self-host.spec.ts');
    expect(smoke).toContain('device-pairing-mobile.spec.ts');
    expect(deployment).toContain('environment access list');
    expect(deployment).toContain('environment access approve <request-id>');
    expect(deployment).toContain(
      'STATION_ALLOWED_ORIGINS=https://station.example.com',
    );
  });

  test('ships src-desktop/tauri.conf.json into the container build for vite config', () => {
    // vite.config.ts imports src-desktop/tauri.conf.json eagerly at config-load
    // time. Regression for container smoke run 30691732234 (file absent from
    // build context): the allowlist must admit ONLY that one src-desktop file,
    // and the Dockerfile build stage must COPY it before `RUN ./station build`.

    // The allowlist admits only src-desktop/tauri.conf.json: un-ignore the
    // directory, re-ignore every entry beneath it, then un-ignore exactly that
    // one file — in that order. Reordering silently re-ignores the file or
    // admits siblings, so the exact three-line sequence is the contract.
    expect(ignore).toMatch(
      /!src-desktop\/\nsrc-desktop\/\*\n!src-desktop\/tauri\.conf\.json\n/,
    );
    expect(ignore.match(/^!src-desktop\/.+/gm)).toEqual([
      '!src-desktop/tauri.conf.json',
    ]);

    // The COPY must land inside the build stage and precede `RUN ./station
    // build` (a COPY only in the runtime stage, or after the build, would
    // reproduce the original smoke failure).
    const buildStage = dockerStage(dockerfile, 'build');
    const buildLines = buildStage.split('\n');
    const copyIdx = buildLines.findIndex((line) =>
      /^COPY\s+src-desktop\/tauri\.conf\.json\b/.test(line),
    );
    const stationBuildIdx = buildLines.findIndex((line) =>
      /RUN\s+(?:\S+=\S+\s+)*\.\/station\s+build/.test(line),
    );
    expect(copyIdx).toBeGreaterThanOrEqual(0);
    expect(stationBuildIdx).toBeGreaterThanOrEqual(0);
    expect(copyIdx).toBeLessThan(stationBuildIdx);

    // The runtime stage consumes only built artifacts — it never copies the
    // source config, from either the host context or the build stage.
    const runtimeStage = dockerStage(dockerfile, 'runtime');
    expect(runtimeStage).toBeTruthy();
    expect(runtimeStage).not.toContain('tauri.conf.json');

    // A literal "tauri.conf.json" absence false-greens if the runtime stage
    // broadly COPYs a tree that carries it transitively — the whole build
    // context (.), the build root (/), the build workspace (/app), or any
    // src-desktop source. The prior loose regex plus a `continue` on
    // single-token lines mis-tokenized JSON-form COPY and skipped malformed
    // lines, so /app/., /app/*, ./., and COPY ["/app", "./"] all slipped
    // through. parseCopySources handles shell AND JSON forms and fails closed
    // (throws on any COPY it cannot fully parse), so every source is seen.
    const runtimeCopySources = parseCopySources(runtimeStage);
    expect(
      runtimeCopySources,
      'runtime stage must COPY at least one artifact',
    ).not.toEqual([]);

    // Primary gate: the runtime stage's COPY sources must be exactly the
    // allowlisted set. Any added source (broad or narrow) fails until the
    // allowlist is consciously updated, so a broad source cannot sneak in.
    expect(new Set(runtimeCopySources)).toEqual(ALLOWED_RUNTIME_COPY_SOURCES);

    // Defense in depth + allowlist-integrity guard: no actual runtime COPY
    // source may itself be broad (the allowlist already excludes them, but this
    // documents the semantic intent and catches a broad entry added to the set).
    for (const src of runtimeCopySources) {
      expect(
        isBroadCopySource(src),
        `runtime COPY source must not be broad (whole context/root/app or src-desktop): "${src}"`,
      ).toBe(false);
    }
  });

  test('admits exactly the lifecycle bootstrap inputs required by Docker COPY', () => {
    for (const path of [
      '.npmrc',
      'config/dependency-lifecycle-allowlist.json',
      'patches/example.patch',
      'scripts/dependency-lifecycle.mjs',
      'scripts/lib/dependency-lifecycle-policy.mjs',
    ])
      expect(dockerContextIncludes(ignore, path)).toBe(true);
    // Post-flip policy: tracked config/ and scripts/ ship wholesale (the
    // repo is public; per-file curation cost five consecutive build breaks).
    // The discriminating exclusions are the test and dogfood trees.
    expect(dockerContextIncludes(ignore, 'config/unrelated.json')).toBe(true);
    expect(
      dockerContextIncludes(ignore, 'scripts/__tests__/unrelated.test.ts'),
    ).toBe(false);
  });
});

// Adversarial in-memory fixtures proving the strengthened parser + broad-source
// detector catch every named false-green variant and still accept the real
// runtime sources. These do not touch the Dockerfile.
describe('runtime COPY source parser', () => {
  describe('isBroadCopySource rejects semantically-broad variants', () => {
    test.each([
      '.',
      './',
      './.',
      './*',
      '/',
      '//',
      '/app',
      '/app/',
      '/app/.',
      '/app/./',
      '/app/*',
      './src-desktop',
      'src-desktop',
      'src-desktop/',
      '/app/src-desktop',
    ])('rejects %s', (src) => {
      expect(isBroadCopySource(src)).toBe(true);
      expect(ALLOWED_RUNTIME_COPY_SOURCES.has(src)).toBe(false);
    });
  });

  describe('current runtime COPY sources are accepted (not broad, allowlisted)', () => {
    test.each([...ALLOWED_RUNTIME_COPY_SOURCES])('accepts %s', (src) => {
      expect(isBroadCopySource(src)).toBe(false);
      expect(ALLOWED_RUNTIME_COPY_SOURCES.has(src)).toBe(true);
    });
  });

  describe('parseCopySources handles shell and JSON forms and fails closed', () => {
    test('parses shell-form COPY with flags and multiple sources', () => {
      const stage = [
        'FROM node AS runtime',
        'WORKDIR /app',
        'COPY --from=build --chown=node:node /app/node_modules ./node_modules',
        'COPY --from=build /app/a /app/b ./dest/',
      ].join('\n');
      expect(parseCopySources(stage)).toEqual([
        '/app/node_modules',
        '/app/a',
        '/app/b',
      ]);
    });

    test('parses JSON-form COPY and surfaces its sources (no false-green)', () => {
      const stage = [
        'FROM node AS runtime',
        'COPY --from=build ["/app", "./"]',
        'COPY ["src/a", "src/b", "/dest"]',
      ].join('\n');
      expect(parseCopySources(stage)).toEqual(['/app', 'src/a', 'src/b']);
    });

    test('joins line-continuation COPY into one directive', () => {
      const stage = [
        'FROM node AS runtime',
        'COPY --from=build \\',
        '  /app/a \\',
        '  /app/b \\',
        '  ./dest',
      ].join('\n');
      expect(parseCopySources(stage)).toEqual(['/app/a', '/app/b']);
    });

    test.each([
      'COPY --from=build ["/app", "./"]',
      'COPY --from=build /app/. ./',
      'COPY --from=build /app/* ./',
      'COPY ./. ./',
      'COPY --from=build /app ./',
      'COPY --from=build / ./',
      'COPY . ./',
    ])('flags the broad variant: %s', (line) => {
      const stage = `FROM node AS runtime\n${line}\n`;
      const sources = parseCopySources(stage);
      expect(sources.length).toBeGreaterThan(0);
      expect(sources.some(isBroadCopySource)).toBe(true);
      expect(sources.every((s) => !ALLOWED_RUNTIME_COPY_SOURCES.has(s))).toBe(
        true,
      );
    });

    test.each([
      'COPY',
      'COPY --from=build',
      'COPY /app',
      'COPY ["src", "dest"',
      'COPY ["src", 42]',
      'COPY ["only"]',
    ])('fails closed on malformed COPY: %s', (line) => {
      const stage = `FROM node AS runtime\n${line}\n`;
      expect(() => parseCopySources(stage)).toThrow();
    });
  });
});
