#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';

export const MAX_NIGHTLY_RESERVATION_RESPONSE_BYTES = 65_536;

function isExactAlreadyExistsError(error, expectedRef) {
  return (
    typeof error === 'object' &&
    error !== null &&
    error.resource === 'Reference' &&
    error.field === 'ref' &&
    error.code === 'already_exists' &&
    (error.value === undefined || error.value === expectedRef)
  );
}

export function classifyNightlyReservationResponse({
  status,
  responseText,
  expectedRef,
  expectedSha,
}) {
  let response;
  try {
    response = JSON.parse(responseText);
  } catch {
    return 'rejected';
  }
  if (typeof response !== 'object' || response === null) return 'rejected';

  if (status === 201) {
    return response.ref === expectedRef && response.object?.sha === expectedSha
      ? 'created'
      : 'rejected';
  }

  if (status !== 422 || response.message !== 'Reference already exists')
    return 'rejected';

  if (!Object.hasOwn(response, 'errors')) return 'reference-already-exists';
  if (!Array.isArray(response.errors)) return 'rejected';
  return response.errors.some((error) =>
    isExactAlreadyExistsError(error, expectedRef),
  )
    ? 'reference-already-exists'
    : 'rejected';
}

function main() {
  const [statusText, responsePath, expectedRef, expectedSha] =
    process.argv.slice(2);
  const status = Number(statusText);
  if (
    !Number.isInteger(status) ||
    !responsePath ||
    !expectedRef ||
    !expectedSha
  )
    throw new Error('nightly reservation response arguments are invalid');
  if (statSync(responsePath).size > MAX_NIGHTLY_RESERVATION_RESPONSE_BYTES)
    throw new Error('nightly reservation response exceeds the size limit');
  const responseText = readFileSync(responsePath, 'utf8');
  process.stdout.write(
    `${classifyNightlyReservationResponse({
      status,
      responseText,
      expectedRef,
      expectedSha,
    })}\n`,
  );
}

if (invokedDirectly(import.meta.url)) main();
