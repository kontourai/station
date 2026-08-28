import {
  getMonitoringTimeLabel,
  getMonitoringTimeSublabel,
  type MonitoringTimeMode,
} from './monitoring-time-range';
import { RELATIVE_TIME_OPTIONS } from './monitoring-utils';

interface MonitoringTimeControlsProps {
  clearTime: Date | null;
  timeMode: MonitoringTimeMode;
  relativeTime: (typeof RELATIVE_TIME_OPTIONS)[number]['value'];
  absoluteStart: string;
  absoluteEnd: string;
  isLiveMode: boolean;
  elapsedLabel: string;
  showTimeControls: boolean;
  onToggleControls: () => void;
  onTimeModeChange: (mode: MonitoringTimeMode) => void;
  onRelativeSelect: (
    value: (typeof RELATIVE_TIME_OPTIONS)[number]['value'],
  ) => void;
  onAbsoluteStartChange: (value: string) => void;
  onAbsoluteEndChange: (value: string) => void;
  onAbsoluteEndNow: () => void;
  onApplyAbsolute: () => void;
  onToggleLiveMode: () => void;
  onClearAll: () => void;
}

export function MonitoringTimeControls(props: MonitoringTimeControlsProps) {
  const timeLabel = getMonitoringTimeLabel({
    clearTime: props.clearTime,
    timeMode: props.timeMode,
    absoluteStart: props.absoluteStart,
    isLiveMode: props.isLiveMode,
    elapsedLabel: props.elapsedLabel,
    relativeTime: props.relativeTime,
  });
  const timeSublabel = getMonitoringTimeSublabel({
    clearTime: props.clearTime,
    timeMode: props.timeMode,
    absoluteStart: props.absoluteStart,
    absoluteEnd: props.absoluteEnd,
    isLiveMode: props.isLiveMode,
    relativeTime: props.relativeTime,
  });

  return (
    <>
      <div className="time-filter-wrapper">
        <button
          type="button"
          onClick={props.onToggleControls}
          className="time-filter-button"
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
          <div className="time-filter-content">
            <span>{timeLabel}</span>
            {timeSublabel && (
              <span className="time-range-sublabel">{timeSublabel}</span>
            )}
          </div>
        </button>

        {props.showTimeControls && (
          <div className="time-controls-dropdown">
            <div className="time-mode-tabs">
              <button
                type="button"
                className={props.timeMode === 'relative' ? 'active' : ''}
                onClick={() => props.onTimeModeChange('relative')}
              >
                Relative
              </button>
              <button
                type="button"
                className={props.timeMode === 'absolute' ? 'active' : ''}
                onClick={() => props.onTimeModeChange('absolute')}
              >
                Absolute
              </button>
            </div>

            {props.timeMode === 'relative' ? (
              <div className="relative-time-options">
                {RELATIVE_TIME_OPTIONS.map((option) => {
                  const now = new Date();
                  const start = new Date(now.getTime() - option.ms);
                  return (
                    <button
                      type="button"
                      key={option.value}
                      className={
                        props.relativeTime === option.value ? 'active' : ''
                      }
                      onClick={() => props.onRelativeSelect(option.value)}
                    >
                      <div className="option-label">{option.label}</div>
                      <div className="option-time">
                        {start.toLocaleString()} {'->'} now
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="absolute-time-inputs">
                <label>
                  Start
                  <input
                    type="datetime-local"
                    value={props.absoluteStart}
                    onChange={(e) =>
                      props.onAbsoluteStartChange(e.target.value)
                    }
                  />
                </label>
                <label>
                  End
                  <div className="time-end-row">
                    <input
                      type="datetime-local"
                      value={props.absoluteEnd}
                      onChange={(e) =>
                        props.onAbsoluteEndChange(e.target.value)
                      }
                      disabled={props.isLiveMode}
                      placeholder="Leave empty for now"
                      className={
                        props.isLiveMode ? 'time-end-input-disabled' : ''
                      }
                    />
                    <button
                      type="button"
                      onClick={props.onAbsoluteEndNow}
                      disabled={props.isLiveMode}
                      className="time-now-button"
                    >
                      Now
                    </button>
                  </div>
                </label>
                <button
                  type="button"
                  className="apply-button"
                  onClick={props.onApplyAbsolute}
                >
                  Apply
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={props.onToggleLiveMode}
        className={`live-mode-toggle ${props.isLiveMode ? 'active' : ''}`}
        // 6-: one toolbar, three toggle conventions — `Auto Follow`
        // exposed `aria-pressed`, LIVE and the event filters exposed a CSS
        // class and nothing else, so their state was invisible to anything
        // that is not a pair of eyes.
        aria-pressed={props.isLiveMode}
        title={
          props.isLiveMode
            ? 'Live mode: streaming real-time events'
            : 'Historical mode: fixed time range'
        }
      >
        <span className="live-dot"></span>
        LIVE
      </button>
      <button
        type="button"
        onClick={props.onClearAll}
        className="btn-secondary"
      >
        CLEAR ALL
      </button>
    </>
  );
}
