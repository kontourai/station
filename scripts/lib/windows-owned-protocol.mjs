export const MAX_WINDOWS_GUARD_RECORD_BYTES = 1024;
const WINDOWS_ROUND_TRIP_UTC_ISO =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{7}Z$/;
const WINDOWS_BOUND = /^BOUND ([1-9]\d*) (\S+)$/;

function isWindowsRoundTripUtcIso(value) {
  const match = WINDOWS_ROUND_TRIP_UTC_ISO.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= daysInMonth[month - 1];
}

export function createWindowsOwnedProtocol() {
  let state = 'awaiting-bound';
  const reject = (message) => ({ ok: false, error: new Error(message) });
  return {
    receive(record) {
      if (
        typeof record !== 'string' ||
        Buffer.byteLength(record) > MAX_WINDOWS_GUARD_RECORD_BYTES
      )
        return reject(
          'Windows owned guard control record is invalid or oversized',
        );
      const bound = WINDOWS_BOUND.exec(record);
      if (
        state === 'awaiting-bound' &&
        bound &&
        isWindowsRoundTripUtcIso(bound[2])
      ) {
        // Windows BOUND identities are canonical round-trip UTC ISO strings.
        // Native creation ticks are normalized to the protocol's microsecond precision
        // before formatting, so persisted lifecycle identities still match.
        state = 'awaiting-resume';
        return {
          ok: true,
          action: 'bound',
          pid: Number(bound[1]),
          processStart: bound[2],
        };
      }
      const complete = /^COMPLETE (-?(?:0|[1-9]\d*))$/.exec(record);
      if (state === 'running' && complete) {
        state = 'complete';
        return { ok: true, action: 'complete', status: Number(complete[1]) };
      }
      return reject(
        `unexpected Windows owned guard control record in ${state}`,
      );
    },
    resume() {
      if (state !== 'awaiting-resume')
        return reject('Windows owned guard is not resumable');
      state = 'running';
      return { ok: true, record: 'RESUME' };
    },
    abort() {
      if (state === 'complete')
        return reject('Windows owned guard is already complete');
      state = 'aborted';
      return { ok: true, record: 'ABORT' };
    },
    state: () => state,
  };
}
