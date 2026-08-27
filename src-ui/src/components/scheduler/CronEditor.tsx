import { useRef, useState } from 'react';
import { usePreviewSchedule } from '../../hooks/useScheduler';

const CRON_FIELDS = [
  { label: 'minute', range: '0-59', allowed: [0, 59] },
  { label: 'hour', range: '0-23', allowed: [0, 23] },
  { label: 'day', range: '1-31', allowed: [1, 31] },
  { label: 'month', range: '1-12', allowed: [1, 12] },
  { label: 'weekday', range: '0-6', allowed: [0, 6] },
];

const CRON_SYNTAX = [
  { sym: '*', desc: 'any value' },
  { sym: ',', desc: 'value list separator' },
  { sym: '-', desc: 'range of values' },
  { sym: '/', desc: 'step values' },
];

function validateCronField(
  value: string,
  min: number,
  max: number,
): string | null {
  if (!value || value.trim() === '') return 'required';
  if (value === '*') return null;
  for (const part of value.split(',')) {
    const [range, step] = part.split('/');
    if (step && (Number.isNaN(+step) || +step < 1))
      return `invalid step "${step}"`;
    if (range === '*') continue;
    if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      if (Number.isNaN(a) || Number.isNaN(b))
        return `"${range}" is not a valid range`;
      if (a < min || b > max) return `range must be ${min}-${max}`;
      if (a > b) return `${a} > ${b} in range`;
    } else {
      const n = Number(range);
      if (Number.isNaN(n)) return `"${range}" is not a number`;
      if (n < min || n > max) return `must be ${min}-${max}`;
    }
  }
  return null;
}

export function CronEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (cron: string) => void;
}) {
  const parts = (value || '* * * * *').split(/\s+/);
  while (parts.length < 5) parts.push('*');
  const [active, setActive] = useState<number | null>(null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const setPart = (idx: number, val: string) => {
    const next = [...parts];
    next[idx] = val;
    onChange(next.join(' '));
  };

  const errors = parts.map((p, i) =>
    validateCronField(p, CRON_FIELDS[i].allowed[0], CRON_FIELDS[i].allowed[1]),
  );
  const hasError = errors.some((e) => e !== null);

  return (
    <div className="cron-editor">
      <div
        className={`cron-editor__fields ${hasError ? 'cron-editor__fields--error' : ''}`}
      >
        {parts.map((p, i) => (
          <input
            key={i}
            id={`cron-field-${i}`}
            ref={(el) => {
              inputRefs.current[i] = el;
            }}
            className={`cron-editor__input ${errors[i] ? 'cron-editor__input--error' : ''}`}
            aria-label={CRON_FIELDS[i].label}
            value={p}
            onChange={(e) => setPart(i, e.target.value)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
          />
        ))}
      </div>
      <div className="cron-editor__labels">
        {CRON_FIELDS.map((f, i) => (
          <label
            key={f.label}
            htmlFor={`cron-field-${i}`}
            className={`cron-editor__label ${!errors[i] && parts[i] !== '*' ? 'cron-editor__label--active' : ''} ${active === i ? 'cron-editor__label--focused' : ''} ${errors[i] ? 'cron-editor__label--error' : ''}`}
          >
            {f.label}
          </label>
        ))}
      </div>
      {(() => {
        const field = active !== null ? CRON_FIELDS[active] : null;
        const err = active !== null ? errors[active] : null;
        return (
          <div className="cron-editor__help">
            <table className="cron-editor__syntax">
              <tbody>
                {CRON_SYNTAX.map((s) => (
                  <tr key={s.sym}>
                    <td className="cron-editor__sym">{s.sym}</td>
                    <td>{s.desc}</td>
                  </tr>
                ))}
                <tr className={err ? 'cron-editor__syntax--error' : ''}>
                  <td className="cron-editor__sym">
                    {field ? field.range : '—'}
                  </td>
                  <td>
                    {err || (field ? 'allowed values' : 'select a field')}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        );
      })()}
      <span className="cron-editor__tz-note">All times are in UTC</span>
    </div>
  );
}

export function cronToHuman(cron: string, referenceDate?: Date): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  if (parts.some((p) => !/^[\d*,\-/]+$/.test(p))) return null;
  const [min, hour, dom, mon, dow] = parts;

  const DAYS = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];
  const MONTHS = [
    '',
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];

  const fmtTime = (h: string, m: string) => {
    const d = referenceDate ? new Date(referenceDate) : new Date();
    d.setUTCHours(parseInt(h, 10), parseInt(m, 10), 0, 0);
    const time = d.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    const tz = d
      .toLocaleTimeString(undefined, { timeZoneName: 'short' })
      .split(' ')
      .pop();
    return `${time} ${tz}`;
  };

  const fmtDow = (d: string) => {
    if (d === '*') return '';
    if (d === '1-5') return 'Monday through Friday';
    if (d === '0,6') return 'weekends';
    return d
      .split(',')
      .map((v) => {
        if (v.includes('-')) {
          const [a, b] = v.split('-').map(Number);
          return `${DAYS[a]} through ${DAYS[b]}`;
        }
        return DAYS[parseInt(v, 10)] || v;
      })
      .join(', ');
  };

  const fmtDom = (d: string) => (d === '*' ? '' : `on day ${d} of the month`);
  const fmtMon = (m: string) =>
    m === '*'
      ? ''
      : `in ${m
          .split(',')
          .map((v) => MONTHS[parseInt(v, 10)] || v)
          .join(', ')}`;

  const parseStep = (field: string) => {
    if (!field.includes('/')) return null;
    const [, step] = field.split('/');
    return { step: parseInt(step, 10) };
  };

  try {
    const minStep = parseStep(min);
    const hourStep = parseStep(hour);

    if (minStep && hour === '*' && dom === '*' && mon === '*' && dow === '*')
      return `Every ${minStep.step} minutes`;

    if (minStep && hour.includes('-') && !hourStep) {
      const [hStart, hEnd] = hour.split('-');
      const start = fmtTime(hStart, '0').replace(/:00\s/, ' ');
      const end = fmtTime(hEnd, '0').replace(/:00\s/, ' ');
      const dowStr = fmtDow(dow);
      const base = `Every ${minStep.step} min, ${start}–${end}`;
      return dowStr ? `${base}, ${dowStr}` : base;
    }

    if (hourStep && min !== '*' && dom === '*' && mon === '*' && dow === '*')
      return `Every ${hourStep.step} hours at :${min.padStart(2, '0')}`;

    const time =
      hour !== '*' && min !== '*'
        ? fmtTime(hour, min)
        : hour === '*' && min === '*'
          ? 'every minute'
          : hour === '*' && min !== '*'
            ? `every hour at :${/^\d+$/.test(min) ? min.padStart(2, '0') : min}`
            : `at minute ${min} of every hour`;
    const dowStr = fmtDow(dow);
    const domStr = fmtDom(dom);
    const monStr = fmtMon(mon);

    if (
      hour !== '*' &&
      min !== '*' &&
      dom === '*' &&
      mon === '*' &&
      dow === '*'
    )
      return `Daily at ${time}`;
    if (
      hour !== '*' &&
      min !== '*' &&
      dom === '*' &&
      mon === '*' &&
      dow === '1-5'
    )
      return `Weekdays at ${time}`;
    if (hour !== '*' && min !== '*' && dom === '*' && mon === '*' && dowStr)
      return `At ${time} on ${dowStr}`;
    if (hour !== '*' && min !== '*' && domStr && mon === '*' && dow === '*')
      return `At ${time} ${domStr}`;

    const pieces = [time, domStr, monStr, dowStr ? `on ${dowStr}` : ''].filter(
      Boolean,
    );
    return pieces.join(' ') || null;
  } catch {
    return null;
  }
}

export function CronPreview({ cron }: { cron: string }) {
  const { data, isLoading } = usePreviewSchedule(cron || null);
  if (!cron) return null;

  const valid = data && Array.isArray(data) && data.length > 0;
  const human = cronToHuman(cron, valid ? new Date(data[0]) : undefined);

  if (isLoading)
    return (
      <div className="schedule__cron-preview">
        <div className="schedule__cron-human schedule__cron-human--muted">
          {human || '--'}
        </div>
        <span className="schedule__cron-label">Next fires:</span>
        <span className="schedule__cron-time">...</span>
      </div>
    );

  return (
    <div className="schedule__cron-preview">
      <div
        className={`schedule__cron-human ${valid ? '' : 'schedule__cron-human--muted'}`}
      >
        {human || '--'}
      </div>
      <span className="schedule__cron-label">Next fires:</span>
      {valid ? (
        data.slice(0, 3).map((d: string, i: number) => (
          <span key={i} className="schedule__cron-time">
            {new Date(d).toLocaleString(undefined, {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
              timeZoneName: 'short',
            })}
          </span>
        ))
      ) : (
        <span className="schedule__cron-time">--</span>
      )}
    </div>
  );
}
