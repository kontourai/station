import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import { afterEach, describe, expect, test } from 'vitest';
import {
  fitDocument,
  isPersonChatRequest,
  type LastUsedEntry,
  ProjectChatDefaultsService,
} from '../project-chat-defaults.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** The read bound the service enforces (`MAX_DOCUMENT_BYTES`), pinned. */
const READ_BOUND = 512 * 1024;

const PERSON = {
  mayBeAnAgent: false,
  automaticBackground: false,
  delegated: false,
  ownerAttributed: false,
};

describe('isPersonChatRequest', () => {
  test('only a person’s own interactive chat counts', () => {
    expect(isPersonChatRequest(PERSON)).toBe(true);
    expect(
      isPersonChatRequest({ ...PERSON, inboundDeviceKind: 'device' }),
    ).toBe(true);
    for (const notPerson of [
      { ...PERSON, mayBeAnAgent: true },
      { ...PERSON, inboundDeviceKind: 'delegation' as const },
      { ...PERSON, automaticBackground: true },
      { ...PERSON, delegated: true },
      { ...PERSON, ownerAttributed: true },
    ])
      expect(isPersonChatRequest(notPerson), JSON.stringify(notPerson)).toBe(
        false,
      );
  });
});

function entry(index: number, models: number): LastUsedEntry {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return {
    projectId: `project-${index}`,
    projectSlug: `project-${index}`,
    userId: `person-${index}-${'x'.repeat(200)}`,
    models: Array.from({ length: models }, (_, model) => ({
      agentSlug: `agent-${model}-${'a'.repeat(60)}`,
      modelId: `model-${model}-${'m'.repeat(120)}`,
      startedAt: at,
    })),
    approval: { approvalMode: 'auto', startedAt: at },
    updatedAt: at,
  };
}

describe('fitDocument', () => {
  test('prunes the oldest entries until the document fits the read bound', () => {
    // Newest first, as the writer orders them; far over the bound.
    const entries = Array.from({ length: 256 }, (_, index) =>
      entry(255 - index, 16),
    );
    expect(
      Buffer.byteLength(JSON.stringify({ version: 1, entries }, null, 2)),
    ).toBeGreaterThan(READ_BOUND);
    const fitted = fitDocument({ version: 1, entries });
    expect(
      Buffer.byteLength(`${JSON.stringify(fitted, null, 2)}\n`),
    ).toBeLessThanOrEqual(READ_BOUND);
    expect(fitted.entries.length).toBeGreaterThan(0);
    expect(fitted.entries.length).toBeLessThan(256);
    // What is kept is the newest prefix, unchanged.
    expect(fitted.entries).toEqual(entries.slice(0, fitted.entries.length));
  });

  test('leaves a document that fits untouched', () => {
    const entries = [entry(2, 2), entry(1, 2)];
    expect(fitDocument({ version: 1, entries })).toEqual({
      version: 1,
      entries,
    });
  });
});

describe('ProjectChatDefaultsService record', () => {
  test('many people and Agents never grow the file past what it can read back', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-chat-defaults-fit-'));
    roots.push(root);
    const projects = new Map<string, ProjectConfig>();
    const service = new ProjectChatDefaultsService({
      homeDir: root,
      getProject: (slug) => projects.get(slug),
    });
    for (let index = 0; index < 40; index += 1) {
      const slug = `p-${index}`;
      projects.set(slug, {
        id: `id-${index}`,
        slug,
        name: slug,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      for (let model = 0; model < 16; model += 1)
        await service.recordStart({
          projectSlug: slug,
          userId: `person-${'p'.repeat(200)}`,
          agentSlug: `agent-${model}-${'a'.repeat(60)}`,
          modelId: `model-${'m'.repeat(1000)}`,
          approvalMode: 'ask',
          startedAt: new Date(
            Date.UTC(2026, 0, 1, 0, index, model),
          ).toISOString(),
        });
    }
    const path = join(root, 'project-chat-last-used.json');
    expect(statSync(path).size).toBeLessThanOrEqual(READ_BOUND);
    const written = JSON.parse(readFileSync(path, 'utf8')) as {
      entries: LastUsedEntry[];
    };
    // Pruned, not refused: older Projects were dropped to make room.
    expect(written.entries.length).toBeLessThan(40);
    // The newest Project's record survives the pruning.
    expect(written.entries[0]?.projectSlug).toBe('p-39');
    expect(
      service.lastUsed(projects.get('p-39')!, `person-${'p'.repeat(200)}`)
        .models,
    ).toHaveLength(16);
  });
});
