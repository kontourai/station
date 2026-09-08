import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_COMMAND_NAME_RULE } from '@kontourai/station-contracts/skill-command';
import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

// The real service reads more counters than the route does; the route-level
// integration test at the bottom of this file constructs one.
vi.mock('../../../telemetry/metrics.js', () => ({
  skillOps: { add: vi.fn() },
  skillDiscoveries: { add: vi.fn() },
  skillActivations: { add: vi.fn() },
  skillActivationDuration: { record: vi.fn() },
  skillDiscoveryDuration: { record: vi.fn() },
  canonicalSkillsDiscovered: { add: vi.fn() },
}));

const { createSkillRoutes } = await import('../skills.js');
const { SkillService } = await import(
  '../../../services/agents/skill-service.js'
);
const { SkillUsageUnreadableError } = await import(
  '../../../services/agents/skill-usage-service.js'
);
const { assertSkillCommandAllowed } = await import(
  '../../../services/agents/skill-command-validation.js'
);
const { assertSafeSkillName } = await import(
  '../../../services/agents/skill-metadata.js'
);

function setup() {
  // The create/update stubs run the REAL service-side refusals against the
  // mocked skill set, so they are attached after the object exists and can
  // close over it. A stub that skipped them would only prove the stub.
  const skillService: any = {
    listSkills: vi
      .fn()
      .mockReturnValue([{ name: 'test-skill', description: 'A test' }]),
    getSkill: vi.fn().mockResolvedValue({
      name: 'test-skill',
      source: 'registry',
      installedAt: '2026-01-01',
      path: '/skills/test-skill',
      body: 'Do things',
    }),
    installSkill: vi
      .fn()
      .mockResolvedValue({ success: true, message: 'Installed' }),
    removeSkill: vi
      .fn()
      .mockResolvedValue({ success: true, message: 'Removed' }),
    isSkillWritable: vi.fn().mockReturnValue(true),
    resolveSkillName: vi.fn((name: string) =>
      name === 'test-skill' ? 'test-skill' : undefined,
    ),
    hasSkill: vi.fn().mockReturnValue(false),
    trackSkillRun: vi.fn().mockResolvedValue({
      runs: 1,
      successes: 0,
      failures: 0,
      qualityScore: null,
    }),
    recordSkillOutcome: vi.fn().mockResolvedValue({
      runs: 1,
      successes: 1,
      failures: 0,
      qualityScore: 100,
    }),
  };
  skillService.createLocalSkill = vi.fn(async (input: any) => {
    assertSafeSkillName(input.name);
    assertSkillCommandAllowed(
      input.name,
      input.command,
      skillService.listSkills(),
    );
    return { success: true, message: 'Created' };
  });
  skillService.updateLocalSkill = vi.fn(
    async (name: string, updates: any, projectHomeDir: string) => {
      if (updates.name !== undefined) assertSafeSkillName(updates.name);
      // The service refuses a write to a package it does not own for EVERY
      // field, not only a command declaration (#1602 review H1). Without this,
      // the stub answered success where the service answers a refusal, and the
      // route's `!result.success` branch had no coverage for the rule at all.
      if (!skillService.isSkillWritable(name, projectHomeDir)) {
        return {
          success: false,
          message: `Skill '${name}' is served from /packages/${name}, which this update does not own; it would have written a second copy to ${projectHomeDir}/skills/${name}`,
        };
      }
      const effectiveName = updates.name ?? name;
      assertSkillCommandAllowed(
        effectiveName,
        updates.command,
        skillService.listSkills(),
        name,
      );
      return { success: true, message: 'Updated' };
    },
  );
  const getProjectHomeDir = vi.fn().mockReturnValue('/home/test');
  const app = createSkillRoutes(skillService as any, getProjectHomeDir);
  return { app, skillService, getProjectHomeDir };
}

describe('Skill Routes', () => {
  test('GET / lists installed skills', async () => {
    const { app } = setup();
    const body = await json(await app.request('/'));
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe('test-skill');
  });

  test('GET /:name returns skill detail', async () => {
    const { app } = setup();
    const body = await json(await app.request('/test-skill'));
    expect(body.success).toBe(true);
    expect(body.data.name).toBe('test-skill');
  });

  test('GET /:name returns 404 for unknown skill', async () => {
    const { app, skillService } = setup();
    skillService.getSkill.mockRejectedValue(new Error('not found'));
    const res = await app.request('/unknown');
    expect(res.status).toBe(404);
  });

  test('POST / installs a skill', async () => {
    const { app, skillService } = setup();
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'new-skill' }),
    });
    expect(res.status).toBe(201);
    expect(skillService.installSkill).toHaveBeenCalledWith(
      'new-skill',
      '/home/test',
    );
  });

  test('POST / returns 400 on install failure', async () => {
    const { app, skillService } = setup();
    skillService.installSkill.mockResolvedValue({
      success: false,
      message: 'No registry',
    });
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bad-skill' }),
    });
    expect(res.status).toBe(400);
  });

  test('POST /local creates a local skill package', async () => {
    const { app, skillService } = setup();
    const res = await app.request('/local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'local-skill', body: 'Do things' }),
    });
    expect(res.status).toBe(201);
    expect(skillService.createLocalSkill).toHaveBeenCalledWith(
      { name: 'local-skill', body: 'Do things' },
      '/home/test',
    );
  });

  test('PUT /:name updates a local skill package', async () => {
    const { app, skillService } = setup();
    const res = await app.request('/test-skill', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'Updated body' }),
    });
    expect(res.status).toBe(200);
    expect(skillService.updateLocalSkill).toHaveBeenCalledWith(
      'test-skill',
      { body: 'Updated body' },
      '/home/test',
    );
  });

  test('DELETE /:name removes a skill', async () => {
    const { app } = setup();
    const body = await json(
      await app.request('/test-skill', { method: 'DELETE' }),
    );
    expect(body.success).toBe(true);
  });

  test('DELETE /:name returns 404 for unknown skill', async () => {
    const { app, skillService } = setup();
    skillService.removeSkill.mockResolvedValue({
      success: false,
      message: 'Not found',
    });
    const res = await app.request('/unknown', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  // The other branch, which had no test at all: an ownership refusal is a 409,
  // and the route reads the service's STRUCTURED reason rather than matching
  // its prose — deriving the status from the message meant any rewording
  // silently reverted this to the 404 above (delta review).
  test('DELETE /:name returns 409 when Station does not own the package', async () => {
    const { app, skillService } = setup();
    skillService.removeSkill.mockResolvedValue({
      success: false,
      reason: 'not-owned',
      message:
        "Cannot remove 'shipper': it is served from /plugins/acme/skills/shipper, which is not a skills root Station writes.",
    });

    const res = await app.request('/shipper', { method: 'DELETE' });
    const body = await json(res);

    expect(res.status).toBe(409);
    expect(body.error).toContain('is not a skills root Station writes');
  });

  // …and a message that happens to read like a refusal is still a 404 without
  // the reason, which is what makes the reason the thing being read.
  test('DELETE /:name does not infer 409 from the message text', async () => {
    const { app, skillService } = setup();
    skillService.removeSkill.mockResolvedValue({
      success: false,
      message: "Cannot remove 'ghost': it is served from nowhere.",
    });

    expect((await app.request('/ghost', { method: 'DELETE' })).status).toBe(
      404,
    );
  });

  test('GET /:name resolves a legacy identifier to the skill that records it', async () => {
    const { app, skillService } = setup();
    skillService.resolveSkillName.mockReturnValue('test-skill');

    const body = await json(await app.request('/some-old-uuid'));

    expect(body.success).toBe(true);
    expect(skillService.resolveSkillName).toHaveBeenCalledWith('some-old-uuid');
    expect(skillService.getSkill).toHaveBeenCalledWith('test-skill');
  });

  test('PUT /:name accepts command and variables', async () => {
    const { app, skillService } = setup();
    const res = await app.request('/test-skill', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: { enabled: true, name: 'ship', global: true },
        variables: [{ name: 'ticket', description: 'Issue key' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(skillService.updateLocalSkill).toHaveBeenCalledWith(
      'test-skill',
      {
        command: { enabled: true, name: 'ship', global: true },
        variables: [{ name: 'ticket', description: 'Issue key' }],
      },
      '/home/test',
    );
  });

  // `_sourceContext` is written by `mcp-manager.ts` onto an agent-authored
  // `update_skill` and is honoured ONLY for a request carrying the internal
  // API token. An untrusted caller asserting "an agent wrote this" would be a
  // provenance label nothing derived, so it is dropped rather than recorded.
  test('PUT /:name drops an untrusted _sourceContext instead of recording it', async () => {
    const { app, skillService } = setup();
    const res = await app.request('/test-skill', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: 'Updated',
        _sourceContext: { kind: 'agent', agentSlug: 'impostor' },
      }),
    });

    expect(res.status).toBe(200);
    expect(skillService.updateLocalSkill).toHaveBeenCalledWith(
      'test-skill',
      { body: 'Updated' },
      '/home/test',
    );
    const updates = skillService.updateLocalSkill.mock.calls[0][1];
    expect(updates).not.toHaveProperty('_sourceContext');
    expect(updates.provenance).toBeUndefined();
  });

  test('PUT /:name refuses command metadata on a read-only skill with 409', async () => {
    const { app, skillService } = setup();
    skillService.isSkillWritable.mockReturnValue(false);

    const res = await app.request('/canonical-skill', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: { enabled: true } }),
    });
    const body = await json(res);

    expect(res.status).toBe(409);
    expect(body.error).toContain('install it to your workspace');
    expect(skillService.updateLocalSkill).not.toHaveBeenCalled();
  });

  test('PUT /:name forwards the service refusal for a read-only skill body as 400', async () => {
    // The route no longer answers this one itself: its 409 covers a command
    // declaration only, and the SERVICE refuses every field on a package it
    // does not own. What is asserted here is the route's half — the request
    // reaches the service, and the service's own reason is what the caller is
    // told, verbatim, rather than a generic failure.
    const { app, skillService } = setup();
    skillService.isSkillWritable.mockReturnValue(false);

    const res = await app.request('/canonical-skill', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'Edited' }),
    });
    const body = await json(res);

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe(
      "Skill 'canonical-skill' is served from /packages/canonical-skill, which this update does not own; it would have written a second copy to /home/test/skills/canonical-skill",
    );
    // The ROUTE did not refuse it: its 409 is for a command declaration, and a
    // body edit is not one.
    expect(skillService.updateLocalSkill).toHaveBeenCalledWith(
      'canonical-skill',
      { body: 'Edited' },
      '/home/test',
    );
  });

  test('PUT /:name refuses a command word another skill already holds', async () => {
    const { app, skillService } = setup();
    skillService.listSkills.mockReturnValue([
      { name: 'other-skill', command: { enabled: true, name: 'ship' } },
    ]);

    const res = await app.request('/test-skill', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: { enabled: true, name: 'ship' } }),
    });
    const body = await json(res);

    expect(res.status).toBe(409);
    expect(body.error).toContain("'/ship'");
    expect(body.error).toContain('other-skill');
  });

  test('PUT /:name allows a skill to keep its own command word', async () => {
    const { app, skillService } = setup();
    skillService.listSkills.mockReturnValue([
      { name: 'test-skill', command: { enabled: true, name: 'ship' } },
    ]);

    const res = await app.request('/test-skill', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: { enabled: true, name: 'ship' } }),
    });

    expect(res.status).toBe(200);
  });

  test('PUT /:name rejects a command name nobody could type after a slash', async () => {
    const { app, skillService } = setup();
    const res = await app.request('/test-skill', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: { enabled: true, name: 'Ship It' } }),
    });

    expect(res.status).toBe(400);
    expect(skillService.updateLocalSkill).not.toHaveBeenCalled();
  });

  test('POST /:name/run counts a run and answers with the stats', async () => {
    const { app, skillService } = setup();
    const body = await json(
      await app.request('/test-skill/run', { method: 'POST' }),
    );

    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      name: 'test-skill',
      stats: { runs: 1, successes: 0, failures: 0, qualityScore: null },
    });
    expect(skillService.trackSkillRun).toHaveBeenCalledWith('test-skill');
  });

  test('POST /:name/run is 404 for a name that resolves to no skill', async () => {
    const { app, skillService } = setup();
    skillService.resolveSkillName.mockReturnValue(undefined);

    const res = await app.request('/ghost/run', { method: 'POST' });

    expect(res.status).toBe(404);
    expect(skillService.trackSkillRun).not.toHaveBeenCalled();
  });

  test('POST /:name/outcome records the outcome', async () => {
    const { app, skillService } = setup();
    const res = await app.request('/test-skill/outcome', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'success' }),
    });
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.data.stats.qualityScore).toBe(100);
    expect(skillService.recordSkillOutcome).toHaveBeenCalledWith(
      'test-skill',
      'success',
    );
  });

  test('POST /:name/outcome rejects an outcome that is not success or failure', async () => {
    const { app, skillService } = setup();
    const res = await app.request('/test-skill/outcome', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'maybe' }),
    });

    expect(res.status).toBe(400);
    expect(skillService.recordSkillOutcome).not.toHaveBeenCalled();
  });

  test('POST /import creates one skill per file, carrying its frontmatter', async () => {
    const { app, skillService } = setup();
    const res = await app.request('/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [
          {
            filename: 'Release Check.md',
            content:
              '---\nname: release-check\ndescription: Ship it\ncommand:\n  enabled: true\n---\nShip {{ticket}}',
          },
          { filename: 'plain.md', content: 'No frontmatter here' },
        ],
      }),
    });
    const body = await json(res);

    expect(res.status).toBe(201);
    expect(body.data.imported).toBe(2);
    expect(body.data.results).toEqual([
      { filename: 'Release Check.md', success: true, name: 'release-check' },
      { filename: 'plain.md', success: true, name: 'plain' },
    ]);
    expect(skillService.createLocalSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'release-check',
        description: 'Ship it',
        command: { enabled: true },
        body: 'Ship {{ticket}}',
      }),
      '/home/test',
    );
    expect(skillService.createLocalSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'plain', body: 'No frontmatter here' }),
      '/home/test',
    );
  });

  test('POST /import reports per-file failures instead of a silent partial success', async () => {
    const { app, skillService } = setup();
    skillService.hasSkill.mockImplementation(
      (name: string) => name === 'taken',
    );

    const res = await app.request('/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [
          { filename: 'taken.md', content: 'Body' },
          { filename: 'fresh.md', content: 'Body' },
        ],
      }),
    });
    const body = await json(res);

    expect(res.status).toBe(207);
    expect(body.data.imported).toBe(1);
    expect(body.data.results[0]).toEqual({
      filename: 'taken.md',
      success: false,
      name: 'taken',
      error: "Skill 'taken' already exists",
    });
    expect(body.data.results[1].success).toBe(true);
    expect(skillService.createLocalSkill).toHaveBeenCalledTimes(1);
  });

  test('POST /import refuses a filename that would escape the skills directory', async () => {
    const { app, skillService } = setup();
    const res = await app.request('/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [
          {
            filename: 'evil.md',
            content: '---\nname: ../../escaped\ndescription: D\n---\nBody',
          },
        ],
      }),
    });
    const body = await json(res);

    expect(res.status).toBe(207);
    expect(body.data.results[0].success).toBe(false);
    expect(skillService.createLocalSkill).not.toHaveBeenCalled();
  });

  test('POST /:name/run answers 503 naming the file when counters are unreadable', async () => {
    const { app, skillService } = setup();
    skillService.trackSkillRun.mockRejectedValue(
      new SkillUsageUnreadableError('/home/test/skills/.usage.json'),
    );

    const res = await app.request('/test-skill/run', { method: 'POST' });
    const body = await json(res);

    expect(res.status).toBe(503);
    expect(body.error).toContain('/home/test/skills/.usage.json');
    expect(body.error).toContain('left untouched');
  });

  test('POST /:name/outcome answers 503 the same way', async () => {
    const { app, skillService } = setup();
    skillService.recordSkillOutcome.mockRejectedValue(
      new SkillUsageUnreadableError('/home/test/skills/.usage.json'),
    );

    const res = await app.request('/test-skill/outcome', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'success' }),
    });

    expect(res.status).toBe(503);
  });

  test('POST /local refuses a command word another root already owns', async () => {
    const { app, skillService } = setup();
    // A canonical package skill — unreachable by PUT, but it still owns /ship.
    skillService.listSkills.mockReturnValue([
      {
        name: 'package-skill',
        origin: 'package',
        command: { enabled: true, name: 'ship' },
      },
    ]);

    const res = await app.request('/local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'mine',
        body: 'Body',
        command: { enabled: true, name: 'ship' },
      }),
    });
    const body = await json(res);

    expect(res.status).toBe(409);
    expect(body.error).toContain('package-skill');
  });

  test('POST /local refuses a skill name that derives no typable command', async () => {
    const { app } = setup();
    const res = await app.request('/local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '🎉🎉',
        body: 'Body',
        command: { enabled: true },
      }),
    });
    const body = await json(res);

    expect(res.status).toBe(409);
    expect(body.error).toContain('no typable command word');
  });

  test('POST /import refuses a file whose frontmatter claims a taken command', async () => {
    const { app, skillService } = setup();
    skillService.listSkills.mockReturnValue([
      { name: 'package-skill', command: { enabled: true, name: 'ship' } },
    ]);

    const res = await app.request('/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [
          {
            filename: 'mine.md',
            content:
              '---\nname: mine\ndescription: D\ncommand:\n  enabled: true\n  name: "ship"\n---\nBody',
          },
        ],
      }),
    });
    const body = await json(res);

    expect(res.status).toBe(207);
    expect(body.data.results[0].success).toBe(false);
    expect(body.data.results[0].error).toContain('package-skill');
  });

  test('POST /import refuses a command word nobody could type', async () => {
    const { app } = setup();
    const res = await app.request('/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [
          {
            filename: 'mine.md',
            content:
              '---\nname: mine\ndescription: D\ncommand:\n  enabled: true\n  name: "Ship It"\n---\nBody',
          },
        ],
      }),
    });
    const body = await json(res);

    expect(res.status).toBe(207);
    // The WHOLE sentence, over HTTP: the server's deep redaction rewrites a
    // quoted "/" as a path, so a rule that quotes the character arrives
    // mangled. This is the assertion that catches it.
    expect(body.data.results[0].error).toContain(SKILL_COMMAND_NAME_RULE);
    expect(body.data.results[0].error).not.toContain('REDACTED');
  });

  test('POST /import refuses a prototype-affecting skill name', async () => {
    const { app, skillService } = setup();
    const res = await app.request('/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [
          {
            filename: 'evil.md',
            content: '---\nname: __proto__\ndescription: D\n---\nBody',
          },
          {
            filename: 'evil2.md',
            content: '---\nname: constructor\ndescription: D\n---\nBody',
          },
        ],
      }),
    });
    const body = await json(res);

    expect(res.status).toBe(207);
    expect(body.data.imported).toBe(0);
    expect(skillService.createLocalSkill).not.toHaveBeenCalled();
  });

  test('POST /local cannot create a prototype-affecting skill name', async () => {
    const { app } = setup();
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      const res = await app.request('/local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, body: 'Body' }),
      });
      const body = await json(res);
      expect(res.status).toBe(400);
      expect(body.error).toContain('Invalid skill name');
    }
  });

  test('POST / refuses a registry id that is not a plain directory name', async () => {
    const { app, skillService } = setup();
    for (const name of ['../candidate', 'a/b', '__proto__', '..', '.hidden']) {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      expect(res.status, name).toBe(400);
    }
    expect(skillService.installSkill).not.toHaveBeenCalled();
  });
});

/**
 * The 409 a user actually reads, produced by the real service.
 *
 * What this adds is the STATUS-AND-BODY wiring: that the refusal reaches the
 * client as a 409 whose `error` is the explanation. Every other DELETE
 * assertion in this file takes `message` from a mock, so none of them can see
 * what the service actually puts there.
 *
 * It is NOT what should have caught the `[object Object]` defect, and the
 * earlier draft of this comment claimed it was. Two tests in
 * `skill-service.test.ts` drive the real `removeSkill` and assert the fragment
 * prose; both were RED at the published head `da33ad2a4`
 * (`2 failed | 86 passed`, `Received: "Cannot remove 'served': [object
 * Object]."`). The defect did not survive because no test could see it. It
 * survived because that suite was not run, or its red was not read.
 *
 * The distinction matters more than the fix: a comment claiming the service
 * suite has no power here is the prose that gets a covering test deleted.
 *
 * Power of THIS test: against the `${refusal}` form it fails on the `[object
 * Object]` assertion. Verified by injection, not by reasoning.
 */
describe('DELETE /:name refusal body, through the real service', () => {
  test('the 409 explains the refusal rather than stringifying it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'skill-route-refusal-'));
    try {
      const served = join(home, 'plugins', 'acme', 'skills', 'served');
      mkdirSync(served, { recursive: true });
      writeFileSync(
        join(served, 'SKILL.md'),
        '---\nname: served\ndescription: From a plugin\n---\nBody',
        'utf-8',
      );

      const service = new SkillService(
        {
          getProjectHomeDir: () => home,
          loadSkill: vi.fn(),
          saveSkillIn: vi.fn(),
          deleteSkillAt: vi.fn(),
          listSkills: vi.fn().mockResolvedValue([]),
          skillExists: vi.fn().mockResolvedValue(false),
        } as never,
        { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      );
      await service.discoverSkills(home);

      const app = createSkillRoutes(service as never, () => home);
      const res = await app.request('/served', { method: 'DELETE' });
      const body = await json(res);

      expect(res.status).toBe(409);
      // The defect this test exists for: an object interpolated into prose.
      expect(body.error).not.toContain('[object Object]');
      // …and the explanation the reader needs is the one that is there.
      expect(body.error).toContain('is not a skills root Station writes');
      expect(existsSync(served), "a plugin's package was deleted").toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
