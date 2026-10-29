import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  isSafeToolServerId,
  type ToolDef,
  type ToolOrigin,
} from '@kontourai/station-contracts/tool';
import { writeJsonDurably } from '@kontourai/station-shared/durable-json-file';
import { readJsonFile } from '@kontourai/station-shared/json-file-storage';
import { z } from 'zod';

const originRecordSchema = z.object({
  version: z.literal(1),
  definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  origin: z.object({
    kind: z.enum(['registry', 'manual']),
    registryId: z.string().max(2048).optional(),
    registryName: z.string().max(512).optional(),
    itemId: z.string().max(512).optional(),
    version: z.string().max(256).optional(),
    location: z.string().max(2048).optional(),
  }),
});

function executionDigest(def: ToolDef): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        def.kind,
        def.transport,
        def.command,
        def.args,
        def.cwd,
        def.endpoint,
        def.headers,
        Object.entries({ ...def.env, ...def.secretEnv }).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
        def.secretEnvRefs,
      ]),
    )
    .digest('hex');
}

/** Registry credentials and URL query strings never become display metadata. */
export function toolOriginLocation(
  source: string | undefined,
): string | undefined {
  if (!source) return undefined;
  try {
    const url = new URL(source);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return source.split(/[?#]/, 1)[0].slice(0, 2048);
  }
}

export function recordIntegrationOrigin(
  home: string,
  def: ToolDef,
  origin: ToolOrigin,
): void {
  if (!isSafeToolServerId(def.id)) throw new Error('Invalid integration id');
  writeJsonDurably(join(home, 'integrations', def.id, 'origin.json'), {
    version: 1,
    definitionDigest: executionDigest(def),
    origin: {
      ...origin,
      registryId: toolOriginLocation(origin.registryId),
      registryName: toolOriginLocation(origin.registryName),
      location: toolOriginLocation(origin.location),
    },
  });
}

export function readIntegrationOrigin(home: string, def: ToolDef): ToolOrigin {
  if (!isSafeToolServerId(def.id)) return { kind: 'unavailable' };
  const file = join(home, 'integrations', def.id, 'origin.json');
  if (!existsSync(file)) return { kind: 'unavailable' };
  try {
    const parsed = originRecordSchema.safeParse(
      readJsonFile<unknown>(file, null, {
        maxBytes: 16 * 1024,
        label: 'Integration origin',
      }),
    );
    if (
      !parsed.success ||
      parsed.data.definitionDigest !== executionDigest(def)
    )
      return { kind: 'unavailable' };
    const record = parsed.data;
    return {
      ...record.origin,
      location: toolOriginLocation(record.origin.location),
    };
  } catch {
    return { kind: 'unavailable' };
  }
}
