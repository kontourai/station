import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { inspectSdkSourceWire } from '../delegation-group-sdk-source-wire-owner.js';
import { setup } from './delegation-source-fixtures/report.js';

test.each([false, true])(
  'report preparation captures each selected Agent once and preserves seat identity (distinct Agents: %s)',
  async (distinct) => {
    const h = await setup();
    const other = {
      name: 'Other reviewer',
      prompt: 'Separate configured instructions',
      execution: {
        modelConnectionId: 'anthropic-1',
        modelId: 'claude-sonnet-4-6',
      },
    };
    if (distinct) await h.f.loader.saveAgent('other', other);
    const input = structuredClone(h.input);
    if (distinct) input.members[1].agentId = 'other';
    const handle = await h.owner.prepare(h.f.context(), input);
    try {
      const prepared = h.owner.read(handle, h.f.req);
      const captures = readdirSync(
        join(h.f.home, 'security', 'provider-credential-observations-v1'),
      ).filter((name) => name.endsWith('.json'));
      assert.equal(captures.length, distinct ? 2 : 1);
      assert.equal(new Set(prepared.members.map((m) => m.taskId)).size, 2);
      assert.equal(
        new Set(prepared.members.map((m) => m.clientTurnId)).size,
        2,
      );
      assert.equal(
        new Set(
          prepared.envelopes
            .slice(1)
            .map((e) => e.execution_binding.source.source_admission_receipt.id),
        ).size,
        2,
      );
      for (const [index, member] of prepared.members.entries()) {
        const sdk = h.owner.sdk(handle, h.f.req, member.seatId);
        const wire = inspectSdkSourceWire(sdk.owner, sdk.sdkHandle).wire;
        assert.ok(
          wire.body.includes(
            distinct && index === 1
              ? other.prompt
              : 'Configured report-only instructions',
          ),
        );
        assert.ok(wire.body.includes(input.members[index].brief));
      }
      await h.f.loader.saveAgent(distinct ? 'other' : 'reviewer', {
        ...other,
        prompt: 'Changed after preparation',
      });
      assert.throws(() => h.owner.read(handle, h.f.req));
      assert.throws(() => h.owner.sdk(handle, h.f.req, 'right'));
      assert.equal(h.rawFetch.mock.calls.length, 0);
    } finally {
      h.owner.close(handle);
    }
  },
);
