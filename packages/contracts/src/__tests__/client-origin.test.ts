import { describe, expect, it } from 'vitest';
import {
  CLIENT_ORIGIN_VERSION,
  parseClientReportedOrigin,
  serializeClientReportedOrigin,
  UNKNOWN_CLIENT_REPORTED_ORIGIN,
} from '../client-origin.js';

describe('client origin contract', () => {
  it('round-trips the bounded reported detail', () => {
    const encoded = serializeClientReportedOrigin({
      version: CLIENT_ORIGIN_VERSION,
      surface: 'mobile',
      build: '0.1.2+abc123',
    });
    expect(parseClientReportedOrigin(encoded)).toEqual({
      version: CLIENT_ORIGIN_VERSION,
      surface: 'mobile',
      build: '0.1.2+abc123',
    });
  });

  it('degrades missing, spoof-shaped, and future values to unknown', () => {
    expect(parseClientReportedOrigin(undefined)).toEqual(
      UNKNOWN_CLIENT_REPORTED_ORIGIN,
    );
    expect(parseClientReportedOrigin('1;web;Mozilla/5.0')).toEqual(
      UNKNOWN_CLIENT_REPORTED_ORIGIN,
    );
    expect(parseClientReportedOrigin('2;desktop;1.0.0')).toEqual(
      UNKNOWN_CLIENT_REPORTED_ORIGIN,
    );
  });
});
