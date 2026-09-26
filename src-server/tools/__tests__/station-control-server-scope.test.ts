/**
 * #2377 slice A (delta review L-2): a station-control tool call must never
 * send the server-self attestation, and two independent layers make sure:
 *
 *  1. `withStationControlCallerContext` leaves any server scope it inherited
 *     (`outsideStationServerScope`);
 *  2. `serverSelfHeaders` sends nothing while a verified-caller context is
 *     present, even if a server scope is (re-)entered inside it.
 *
 * Each test below bypasses the OTHER layer, so each layer is pinned alone.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  __resetStationServerSelfAttestationForTests,
  enableStationServerSelfAttestation,
  INTERNAL_SERVER_SELF_HEADER,
  runAsStationServer,
  stationServerScopeHeaders,
} from '../../security/station-server-scope.js';
import {
  __resetStationControlStdioCallerCredentialForTests,
  controlRequestOptions,
  withStationControlCallerContext,
} from '../station-control-shared.js';

const context = { token: 'caller-token', resolve: () => null };

beforeAll(() => {
  __resetStationControlStdioCallerCredentialForTests();
  enableStationServerSelfAttestation();
});
afterAll(() => {
  __resetStationServerSelfAttestationForTests();
});

describe('a tool call never carries the server attestation', () => {
  test('control: server code inside a scope does carry it', () => {
    const headers = runAsStationServer(
      () => controlRequestOptions().headers as Record<string, string>,
    );
    expect(headers[INTERNAL_SERVER_SELF_HEADER]).toBeDefined();
  });

  test('layer 1: entering a caller context leaves the inherited server scope', () => {
    // Reads the scope directly, so layer 2 (the caller-context check in
    // `serverSelfHeaders`) plays no part.
    const inside = runAsStationServer(() =>
      withStationControlCallerContext(context, () =>
        stationServerScopeHeaders(),
      ),
    );
    expect(inside).toEqual({});
  });

  test('layer 2: a caller context suppresses the attestation even inside a server scope', () => {
    // The scope is re-entered INSIDE the caller context, so layer 1 (leaving
    // the inherited scope) plays no part.
    const headers = withStationControlCallerContext(context, () =>
      runAsStationServer(
        () => controlRequestOptions().headers as Record<string, string>,
      ),
    );
    expect(headers[INTERNAL_SERVER_SELF_HEADER]).toBeUndefined();
  });
});
