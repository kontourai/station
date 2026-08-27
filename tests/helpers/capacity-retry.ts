import type { Page } from '@playwright/test';

export const CAPACITY_RETRY_ANSWER_TIMEOUT_MS = 90_000;
const CAPACITY_RETRY_INTERVAL_MS = 2_000;
const ANSWER_POLL_INTERVAL_MS = 250;

export type CapacityRetryObservation = {
  answerVisible(): Promise<boolean>;
  capacityRetryVisible(): Promise<boolean>;
  retryCapacity(): Promise<void>;
  capacityDetail(): Promise<string>;
  wait(milliseconds: number): Promise<void>;
  now(): number;
};

/**
 * Follow the browser's own resource-admission recovery path without changing
 * admission policy. A capacity refusal is not an answer and must remain
 * visible; the journey gives the host time to recover, activates its Retry
 * control at a bounded cadence, and otherwise preserves the original answer
 * deadline.
 */
export async function waitForAnswerThroughCapacityRetry(
  observation: CapacityRetryObservation,
  timeoutMs = CAPACITY_RETRY_ANSWER_TIMEOUT_MS,
): Promise<{ capacityRetries: number }> {
  const startedAt = observation.now();
  const deadline = startedAt + timeoutMs;
  let retries = 0;
  let nextRetryAt = startedAt;
  let lastCapacityDetail = 'none observed';

  while (observation.now() < deadline) {
    if (await observation.answerVisible()) return { capacityRetries: retries };

    const now = observation.now();
    if (now >= nextRetryAt && (await observation.capacityRetryVisible())) {
      lastCapacityDetail = await observation.capacityDetail();
      await observation.retryCapacity();
      retries += 1;
      nextRetryAt = observation.now() + CAPACITY_RETRY_INTERVAL_MS;
    }

    await observation.wait(
      Math.min(
        ANSWER_POLL_INTERVAL_MS,
        Math.max(1, deadline - observation.now()),
      ),
    );
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for the fixture answer. Activated the visible host-capacity Retry control ${retries} time(s); last capacity notice: ${lastCapacityDetail}`,
  );
}

/** Browser adapter for the production-visible capacity refusal and its action. */
export async function waitForVisibleAnswerThroughCapacityRetry(
  page: Page,
  answer: string,
  timeoutMs = CAPACITY_RETRY_ANSWER_TIMEOUT_MS,
): Promise<{ capacityRetries: number }> {
  const answerLocator = page.getByText(answer, { exact: true });
  const capacityNotice = page
    .locator('.ephemeral-message')
    .filter({ hasText: 'Host is at capacity' })
    .last();
  const retry = capacityNotice.getByRole('button', {
    name: 'Retry',
    exact: true,
  });
  return waitForAnswerThroughCapacityRetry(
    {
      answerVisible: () => answerLocator.isVisible(),
      capacityRetryVisible: () => retry.isVisible(),
      retryCapacity: () => retry.click(),
      capacityDetail: async () => (await capacityNotice.innerText()).trim(),
      wait: (milliseconds) => page.waitForTimeout(milliseconds),
      now: () => Date.now(),
    },
    timeoutMs,
  );
}
