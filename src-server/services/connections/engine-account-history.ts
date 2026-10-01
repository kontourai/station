import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type {
  EngineAccountUsage,
  EngineAccountUsageHistory,
} from '@kontourai/station-contracts/engine-accounts';
import {
  mutateJsonFileWithGuardedRead,
  readJsonFile,
} from '@kontourai/station-shared/json-file-storage';
import { z } from 'zod';
import { resolveHomeDir } from '../../utils/paths.js';

const retentionDays = 30;
const observationSchema = z
  .object({
    fetchedAt: z.string().datetime({ offset: true }),
    status: z.enum(['ok', 'unknown']),
    windows: z
      .array(
        z
          .object({
            id: z.string().max(200),
            label: z.string().max(200),
            usedPercent: z.number().min(0).max(100),
            resetsAt: z.string().optional(),
            durationSeconds: z.number().positive().optional(),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
const storeSchema = z
  .object({
    version: z.literal(1),
    identity: z.string().nullable(),
    lastRequestStartedAt: z.string().datetime({ offset: true }),
    observations: z.array(observationSchema).max(720),
  })
  .strict();
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Retain hourly observations without persisting identity, credentials or raw responses. */
export async function recordEngineAccountUsage(
  target: {
    engine: 'claude' | 'codex';
    connectionId: string;
    ref: string | null;
    dir: string;
  },
  usage: EngineAccountUsage,
  options: {
    homeDir?: string;
    requestStartedAt?: string;
    beforeCommit?: () => void;
  } = {},
): Promise<EngineAccountUsageHistory> {
  const key = digest([
    target.engine,
    target.connectionId,
    target.ref,
    target.dir,
  ]);
  const path = join(
    options.homeDir ?? resolveHomeDir(),
    'analytics',
    'engine-allowance',
    `${key}.json`,
  );
  const identity = usage.metadata?.identity;
  const identityKey =
    identity && Object.values(identity).some(Boolean) ? digest(identity) : null;
  const observation = observationSchema.parse({
    fetchedAt: usage.fetchedAt,
    status: usage.status,
    windows:
      usage.status === 'ok'
        ? usage.windows
            .slice(0, 32)
            .map(({ id, label, usedPercent, resetsAt, durationSeconds }) => ({
              id,
              label,
              usedPercent,
              ...(resetsAt ? { resetsAt } : {}),
              ...(durationSeconds ? { durationSeconds } : {}),
            }))
        : [],
  });
  const cutoff = Date.parse(usage.fetchedAt) - retentionDays * 86400000;
  const requestStartedAt = options.requestStartedAt ?? usage.fetchedAt;
  const fallback = {
    version: 1,
    identity: null,
    lastRequestStartedAt: requestStartedAt,
    observations: [],
  };
  const bounds = {
    maxBytes: 2 * 1024 * 1024,
    label: 'Engine allowance history',
  };
  const store = await mutateJsonFileWithGuardedRead<unknown>(
    path,
    fallback,
    async () => readJsonFile<unknown>(path, fallback, bounds),
    (value) => {
      const current = storeSchema.parse(value);
      if (
        identityKey &&
        current.identity &&
        identityKey !== current.identity &&
        Date.parse(requestStartedAt) <= Date.parse(current.lastRequestStartedAt)
      )
        return current;
      const previous =
        identityKey && current.identity && identityKey !== current.identity
          ? []
          : current.observations;
      const hour = new Date(observation.fetchedAt).toISOString().slice(0, 13);
      const existingHour = previous.find(
        (item) => new Date(item.fetchedAt).toISOString().slice(0, 13) === hour,
      );
      if (
        existingHour &&
        Date.parse(existingHour.fetchedAt) > Date.parse(observation.fetchedAt)
      )
        return current;
      const observations = previous.filter(
        (item) =>
          Date.parse(item.fetchedAt) >= cutoff &&
          new Date(item.fetchedAt).toISOString().slice(0, 13) !== hour,
      );
      observations.push(observation);
      observations.sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
      return {
        version: 1,
        identity: identityKey ?? current.identity,
        lastRequestStartedAt:
          Date.parse(requestStartedAt) >
          Date.parse(current.lastRequestStartedAt)
            ? requestStartedAt
            : current.lastRequestStartedAt,
        observations: observations.slice(-720),
      };
    },
    { ...bounds, beforeCommit: options.beforeCommit },
  );
  return {
    status: 'ok',
    retentionDays,
    observations: storeSchema.parse(store).observations,
  };
}
