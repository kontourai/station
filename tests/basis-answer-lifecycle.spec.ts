import { readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import type { StationAnswerAssessmentReadTarget } from '@kontourai/station-contracts/answer-assessment';
import type { StationBasisProjection } from '@kontourai/station-contracts/task-basis';
import type { TaskTurnReferenceProjection } from '@kontourai/station-sdk';
import { validateTrustBundle } from '@kontourai/surface';
import { expect } from '@playwright/test';
import {
  seedE2EFirstRunDecision,
  seedE2EUsageTelemetryDisclosure,
} from '../scripts/run-e2e-suite.mjs';
import { expectNoBlockingAccessibilityViolations } from './helpers/accessibility';
import { ensureChatDockOpen } from './helpers/agents-journey';
import { readE2EOperatorCredential } from './helpers/e2e-operator-credential';
import { test } from './helpers/fixture-audit';
import {
  allocateLiveStation,
  apiJson,
  createProject,
  createRepository,
  startStation,
  stopStation,
} from './helpers/live-station-task';
import {
  closeFixtureServer,
  startOllamaFixture,
} from './helpers/ollama-fixture';
import { pairBrowser } from './live/helpers/station-instance.mjs';

const REPLY = 'The retained Basis answer survives restart.';

/** Real local model transport, durable owners and UI; no protected route mocks. */
test('inspect before Keep, retain the exact answer, restart, and revoke its assessment without rewriting it', async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(360_000);
  const live = await allocateLiveStation(
    'station-basis-lifecycle-',
    'e2e-extended',
  );
  let fixture: Server | null = null;
  let stopped = false;
  try {
    await startStation(live, true, {
      logFile: testInfo.outputPath('basis-lifecycle.log'),
      environment: {
        ...process.env,
        STATION_E2E_SUPPRESS_NATIVE_ENGINE_ADOPTION: '1',
      },
    });
    const credential = readE2EOperatorCredential(live.home);
    await seedE2EFirstRunDecision(live.api, credential);
    await seedE2EUsageTelemetryDisclosure(live.api, credential);
    await pairBrowser(page, {
      root: process.cwd(),
      instance: live.instance,
      serverPort: live.serverPort,
      uiOrigin: live.ui,
    });
    const repository = join(live.home, 'fixture-workspace');
    await createRepository(repository, 'basis-lifecycle');
    await createProject(page, 'basis-lifecycle', repository);
    const project = await apiJson<{ data: { id: string } }>(
      page,
      '/api/projects/basis-lifecycle',
    );
    expect(project.data.id).toBeTruthy();
    const task = await apiJson<{ success: boolean; data: { id: string } }>(
      page,
      '/api/tasks',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'basis-lifecycle',
          title: 'Retained Basis answer',
        }),
      },
    );
    expect(task).toMatchObject({ success: true });
    const model = await startOllamaFixture(
      'basis-lifecycle:latest',
      undefined,
      REPLY,
    );
    fixture = model.server;
    const connection = await apiJson<{ success: boolean }>(
      page,
      '/api/connections',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'basis-lifecycle-model',
          kind: 'model',
          type: 'ollama',
          name: 'Basis lifecycle model',
          enabled: true,
          capabilities: ['llm'],
          config: { baseUrl: model.origin, defaultModel: model.model },
          status: 'ready',
          prerequisites: [],
        }),
      },
    );
    expect(connection.success).toBe(true);
    const agent = await apiJson<{ success: boolean }>(page, '/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'basis-lifecycle',
        name: 'Basis lifecycle',
        prompt: 'Answer briefly.',
      }),
    });
    expect(agent.success).toBe(true);
    await page.goto(live.ui);
    const draft = page.getByRole('form', { name: 'Start work' });
    await draft.getByRole('button', { name: /^Project:/ }).click();
    await page
      .getByRole('dialog', { name: 'Choose project' })
      .locator('[data-context-value="basis-lifecycle"]')
      .click();
    await draft.getByRole('button', { name: /^Agent:/ }).click();
    await page
      .getByRole('dialog', { name: 'Choose agent' })
      .locator('[data-agent-slug="basis-lifecycle"]')
      .click();
    await draft
      .getByRole('textbox', { name: 'What would you like done?', exact: true })
      .fill('Retain this exact answer.');
    await draft.getByRole('button', { name: 'Start', exact: true }).click();
    await ensureChatDockOpen(page);
    const dock = page.locator('#chat-dock');
    await expect(dock.getByText(REPLY, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    const inventoryRead = page.waitForResponse(
      (response) =>
        response.url().includes('/inventory?') &&
        response.url().includes('scope=current-answer') &&
        response.ok(),
    );
    await dock
      .getByRole('button', { name: /^Basis/ })
      .first()
      .click();
    const inventory = (await (await inventoryRead).json()) as {
      data: { scope: { sessionId: string; turnId: string } };
    };
    const { sessionId, turnId } = inventory.data.scope;
    expect(sessionId).toContain(':');
    const portable = await apiJson<{ success: boolean }>(
      page,
      `/api/orchestration/sessions/${encodeURIComponent(sessionId)}/inventory/app-read`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 'station.session-inventory-mcp/v2',
          operation: 'open',
          scope: { kind: 'current-answer', sessionId, turnId },
        }),
      },
    );
    expect(portable).toMatchObject({ success: true });
    const assessmentPath = `/api/orchestration/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/assessment`;
    const beforeKeep = await apiJson<{ data: unknown[] }>(
      page,
      `/api/tasks/${task.data.id}/turn-references`,
    );
    expect(beforeKeep.data).toEqual([]);
    const keep = dock.getByRole('button', {
      name: 'Keep in Task: this answer',
    });
    await keep.click();
    const picker = page.getByRole('dialog', { name: 'Keep answer in Task' });
    await picker.getByRole('button', { name: /Retained Basis answer/ }).click();
    await picker.getByRole('button', { name: 'Add to Task' }).click();
    await expect(picker).toHaveCount(0);
    await expect(keep).toBeFocused();
    const retained = await apiJson<{ data: TaskTurnReferenceProjection[] }>(
      page,
      `/api/tasks/${task.data.id}/turn-references`,
    );
    expect(retained.data).toMatchObject([
      { sessionId, turnId, state: 'available' },
    ]);
    const keptAnswer = retained.data[0];
    if (keptAnswer?.state !== 'available')
      throw new Error('Exact kept answer is unavailable');
    const referenceId = keptAnswer.id;
    expect(keptAnswer.answer.parts).toContainEqual({ type: 'text', text: REPLY });
    const target = await apiJson<{ data: StationAnswerAssessmentReadTarget }>(
      page,
      `${assessmentPath}/target`,
    );
    const today = new Date().toISOString().slice(0, 10);
    const bundle = validateTrustBundle(
      JSON.parse(
        readFileSync(
          'node_modules/@kontourai/surface/examples/answer-provenance.json',
          'utf8',
        ).replaceAll('2026-08-25', today),
      ),
    );
    const claim = bundle.claims.find((item) => item.id === 'answer.supported');
    if (!claim)
      throw new Error('Published Surface fixture has no answer claim');
    Object.assign(claim, {
      subjectType: target.data.profile.subjectType,
      subjectId: target.data.profile.subjectId,
      claimType: target.data.profile.claimType,
      metadata: { ...claim.metadata, ...target.data.profile.metadata },
    });
    const published = await apiJson<{
      success: boolean;
      data: { revision: number };
    }>(page, assessmentPath, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedAnswer: target.data.expectedAnswer,
        publicationId: 'basis-lifecycle',
        bundle,
        claimId: claim.id,
        expectedRevision: target.data.revision,
      }),
    });
    expect(published.success).toBe(true);
    const basisPath = `/api/tasks/${task.data.id}/basis?answerReferenceId=${encodeURIComponent(referenceId)}`;
    const assessed = await apiJson<{ data: StationBasisProjection }>(
      page,
      basisPath,
    );
    expect(assessed.data.standing).toBe('policy-met');
    const exactBinding = assessed.data.answer;
    await stopStation(live);
    stopped = true;
    await startStation(live, false, {
      logFile: testInfo.outputPath('basis-restart.log'),
      environment: {
        ...process.env,
        STATION_E2E_SUPPRESS_NATIVE_ENGINE_ADOPTION: '1',
      },
    });
    stopped = false;
    await pairBrowser(page, {
      root: process.cwd(),
      instance: live.instance,
      serverPort: live.serverPort,
      uiOrigin: live.ui,
    });
    await page.goto(`${live.ui}/tasks/${task.data.id}`);
    await page.getByRole('tab', { name: 'Details', exact: true }).click();
    await page.locator('summary', { hasText: 'Answer details' }).click();
    await page
      .getByRole('button', { name: 'Inspect evidence', exact: true })
      .click();
    await expect(
      page.locator('.station-basis-pane:visible').getByRole('status'),
    ).toContainText('Policy met');
    await expectNoBlockingAccessibilityViolations(
      page,
      'basis-answer-lifecycle',
      '.station-basis-pane',
    );
    const removed = await apiJson<{ success: boolean }>(page, assessmentPath, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: published.data.revision }),
    });
    expect(removed.success).toBe(true);
    await expect(
      page.locator('.station-basis-pane:visible').getByRole('status'),
    ).toContainText('Unassessed');
    const after = await apiJson<{ data: StationBasisProjection }>(
      page,
      basisPath,
    );
    expect(after.data.standing).toBe('execution-only');
    expect(after.data.answer).toEqual(exactBinding);
    const reopened = await apiJson<{ data: TaskTurnReferenceProjection[] }>(
      page,
      `/api/tasks/${task.data.id}/turn-references`,
    );
    expect(reopened.data).toMatchObject([
      { id: referenceId, sessionId, turnId, answer: keptAnswer.answer },
    ]);
  } finally {
    if (!stopped) await stopStation(live);
    await closeFixtureServer(fixture);
    if (testInfo.status === testInfo.expectedStatus)
      rmSync(live.home, { recursive: true, force: true });
  }
});
