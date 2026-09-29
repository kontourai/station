import { expect, test } from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';

const API = resolveE2EApiBase();

/**
 * The suite's authentication canary. Every spec that seeds state through
 * `authenticatedRequest` would still pass against a server started with
 * authentication disabled, and against a fixture that leaked its operator
 * bearer into Playwright's ordinary request context. This is the one live
 * proof of both halves: the fixture's real credential is accepted on an
 * operator route, and the same route refuses a context that carries none.
 */
test('the operator credential reaches an operator route and an ordinary request context is refused', async ({
  authenticatedRequest,
  playwright,
}) => {
  const operatorResponse = await authenticatedRequest.get(
    `${API}/api/pairing/requests`,
  );
  expect(operatorResponse.ok()).toBe(true);

  const ordinaryRequest = await playwright.request.newContext();
  try {
    const unauthenticatedResponse = await ordinaryRequest.get(
      `${API}/api/pairing/requests`,
    );
    expect(unauthenticatedResponse.status()).toBe(401);
  } finally {
    await ordinaryRequest.dispose();
  }
});
