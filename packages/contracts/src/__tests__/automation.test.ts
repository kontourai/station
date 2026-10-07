import { readFileSync } from 'node:fs';
import * as subpath from '@kontourai/station-contracts/automation';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AutomationDeliveryOutcome,
  AutomationEvent,
  AutomationEventType,
  AutomationMatcher,
  AutomationSource,
  AutomationSourceProjection,
} from '../automation.js';

describe('@kontourai/station-contracts/automation', () => {
  it('is published as its own package subpath', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, string> };
    expect(manifest.exports['./automation']).toBe('./src/automation.ts');
    expect(subpath.AUTOMATION_SCHEMA_VERSION).toBe(1);
  });

  it('starts the GitHub allow-list at completed workflow runs only', () => {
    expect(subpath.GITHUB_AUTOMATION_EVENT_ALLOWLIST).toEqual({
      workflow_run: ['completed'],
    });
    expect(Object.keys(subpath.AUTOMATION_EVENT_FIELDS)).toEqual([
      'github.workflow_run.completed',
    ]);
    expectTypeOf<AutomationEventType>().toEqualTypeOf<'github.workflow_run.completed'>();
  });

  it('keeps the delivery outcome union closed', () => {
    expect(subpath.AUTOMATION_DELIVERY_OUTCOMES).toEqual([
      'received',
      'duplicate',
      'refused',
      'ignored',
      'no-match',
      'matched',
      'suppressed',
      'started',
      'failed',
      'indeterminate',
    ]);
    expectTypeOf<AutomationDeliveryOutcome>().toEqualTypeOf<
      (typeof subpath.AUTOMATION_DELIVERY_OUTCOMES)[number]
    >();
    // @ts-expect-error an outcome outside the closed list is not an outcome
    const invented: AutomationDeliveryOutcome = 'retried';
    expect(invented).toBe('retried');
  });

  it('never carries a webhook secret in the API projection', () => {
    type WebhookProjection = Extract<
      AutomationSourceProjection,
      { kind: 'github-webhook' }
    >;
    expectTypeOf<WebhookProjection>().not.toHaveProperty('secret');
    expectTypeOf<WebhookProjection['hasSecret']>().toEqualTypeOf<true>();
    expectTypeOf<
      Extract<AutomationSource, { kind: 'github-webhook' }>['secret']
    >().toEqualTypeOf<string>();
  });

  it('accepts only exact string values in a matcher', () => {
    const matcher: AutomationMatcher = {
      type: 'github.workflow_run.completed',
      where: {
        'run.conclusion': ['failure', 'timed_out'],
        'run.event': 'schedule',
      },
    };
    expect(matcher.where['run.event']).toBe('schedule');
    const regex: AutomationMatcher = {
      type: 'github.workflow_run.completed',
      // @ts-expect-error a regex is not an exact value
      where: { 'run.head_branch': /main/ },
    };
    expect(regex.type).toBe('github.workflow_run.completed');
  });

  it('exposes every operator verb to API and CLI, and only reads to MCP', () => {
    const surface = subpath.AUTOMATION_OPERATOR_SURFACE;
    expect(Object.keys(surface).sort()).toEqual(
      [...subpath.AUTOMATION_OPERATOR_OPERATIONS].sort(),
    );
    const cli = Object.values(surface).map(({ cli }) => cli);
    expect(new Set(cli).size).toBe(cli.length);
    for (const [operation, entry] of Object.entries(surface)) {
      expect(entry.path.startsWith('/automations/'), operation).toBe(true);
      // An agent must never create, widen or enable its own triggers.
      if (entry.method === 'GET')
        expect(entry.mcp, operation).toMatch(/^[a-z_]+$/);
      else expect(entry.mcp, operation).toBeNull();
    }
  });

  it('keeps every default inside its published bounds', () => {
    const limits = subpath.AUTOMATION_EXECUTION_LIMITS;
    expect(limits.defaultEpisodeMaxAttempts).toBeLessThanOrEqual(
      limits.maxEpisodeAttempts,
    );
    expect(limits.defaultMaxStartsPerHour).toBeLessThanOrEqual(
      limits.maxStartsPerHour,
    );
    expect(limits.minPollIntervalMs).toBeLessThanOrEqual(
      limits.defaultPollIntervalMs,
    );
    expect(limits.defaultPollIntervalMs).toBeLessThanOrEqual(
      limits.maxPollIntervalMs,
    );
    expect(limits.minWebhookSecretLength).toBeLessThan(
      limits.maxWebhookSecretLength,
    );
    // Dedupe must outlive the freshness window: an event young enough to be
    // accepted must still find its dedupe row.
    expect(limits.deliveryRetentionMs).toBeGreaterThan(limits.maxEventAgeMs);
  });

  it('carries event fields as strings so matching is string equality', () => {
    const event: AutomationEvent['fields'] = { 'run.id': '123' };
    expect(event['run.id']).toBe('123');
    // @ts-expect-error numbers are canonicalized to strings by the normalizer
    const numeric: AutomationEvent['fields'] = { 'run.id': 123 };
    expect(numeric['run.id']).toBe(123);
    // A matcher value '1' therefore never meets an un-normalized number 1.
    expectTypeOf<AutomationEvent['fields'][string]>().toEqualTypeOf<string>();
  });

  it('lets only accepted outcomes take part in semantic dedupe', () => {
    const accepted: readonly string[] =
      subpath.AUTOMATION_SEMANTIC_DEDUPE_OUTCOMES;
    expect(accepted).not.toContain('refused');
    expect(accepted).not.toContain('received');
    expect(accepted).not.toContain('duplicate');
  });
});
