import { useEffect, useRef, useState } from 'react';
import { useTopmostModal } from './components/useTopmostModal';
import { useContactSearch } from './data';
import type { CreateEventInput, UpdateEventInput } from './data/providers';

export interface EventModalData {
  meetingId?: string;
  meetingChangeKey?: string;
  subject?: string;
  start?: string; // HH:MM
  end?: string;
  attendees?: Array<{ email: string; name?: string }>;
  location?: string;
  body?: string;
}

interface CreateEventModalProps {
  selectedDate: Date;
  onClose: () => void;
  onSubmit: (input: CreateEventInput) => void;
  onUpdate?: (input: UpdateEventInput) => void;
  isPending: boolean;
  initial?: EventModalData;
}

function toLocalISO(date: Date, time: string): string {
  const [h, m] = time.split(':');
  const d = new Date(date);
  d.setHours(Number.parseInt(h, 10), Number.parseInt(m, 10), 0, 0);
  return d.toISOString();
}

function defaultStart(): string {
  const now = new Date();
  now.setMinutes(Math.ceil(now.getMinutes() / 30) * 30, 0, 0);
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function addMins(time: string, mins: number): string {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(2000, 0, 1, h, m + mins);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function CreateEventModal({
  selectedDate,
  onClose,
  onSubmit,
  onUpdate,
  isPending,
  initial,
}: CreateEventModalProps) {
  const isEdit = !!initial?.meetingId;
  const startDefault = initial?.start || defaultStart();

  const [date, setDate] = useState(selectedDate);
  const [subject, setSubject] = useState(initial?.subject || '');
  const [startTime, setStartTime] = useState(startDefault);
  const [endTime, setEndTime] = useState(
    initial?.end || addMins(startDefault, 30),
  );
  const [attendees, setAttendees] = useState<
    Array<{ email: string; name?: string }>
  >(initial?.attendees || []);
  const [location, setLocation] = useState(initial?.location || '');
  const [body, setBody] = useState(initial?.body || '');

  const [contactQuery, setContactQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const { data: suggestions } = useContactSearch(contactQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  const subjectInputRef = useRef<HTMLInputElement>(null);
  const { dialogRef, onKeyDown: onDialogKeyDown } = useTopmostModal({
    onClose,
    initialFocusRef: subjectInputRef,
  });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        inputRef.current &&
        !inputRef.current.parentElement?.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const addAttendee = (email: string, name?: string) => {
    const trimmed = email.trim().toLowerCase();
    if (trimmed && !attendees.some((a) => a.email.toLowerCase() === trimmed)) {
      setAttendees((prev) => [...prev, { email: trimmed, name }]);
    }
    setContactQuery('');
    setShowSuggestions(false);
    inputRef.current?.focus();
  };

  const removeAttendee = (email: string) => {
    setAttendees((prev) => prev.filter((a) => a.email !== email));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',') {
      e.preventDefault();
      if (contactQuery.includes('@')) {
        addAttendee(contactQuery);
      } else if (suggestions?.length === 1) {
        addAttendee(suggestions[0].email, suggestions[0].name);
      }
    }
    if (e.key === 'Backspace' && !contactQuery && attendees.length) {
      removeAttendee(attendees[attendees.length - 1].email);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!subject.trim()) return;
    const emails = attendees.map((a) => a.email);
    if (isEdit && onUpdate) {
      onUpdate({
        meetingId: initial!.meetingId!,
        meetingChangeKey: initial?.meetingChangeKey,
        subject: subject.trim(),
        start: toLocalISO(date, startTime),
        end: toLocalISO(date, endTime),
        attendees: emails.length ? emails : undefined,
        location: location.trim() || undefined,
        body: body.trim() || undefined,
      });
    } else {
      onSubmit({
        subject: subject.trim(),
        start: toLocalISO(date, startTime),
        end: toLocalISO(date, endTime),
        attendees: emails.length ? emails : undefined,
        location: location.trim() || undefined,
        body: body.trim() || undefined,
      });
    }
  };

  const filteredSuggestions =
    suggestions?.filter(
      (s) =>
        !attendees.some((a) => a.email.toLowerCase() === s.email.toLowerCase()),
    ) || [];

  return (
    <div className="crm-modal-overlay">
      <button
        type="button"
        className="enterprise-modal-backdrop enterprise-modal-backdrop--fill"
        tabIndex={-1}
        aria-label="Close dialog"
        onClick={onClose}
      />
      <div
        className="crm-modal-content crm-modal-content--sm enterprise-modal-layer"
        ref={dialogRef}
        onKeyDown={onDialogKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-event-title"
      >
        <div className="crm-modal-header">
          <h2
            id="create-event-title"
            className="crm-modal-title crm-modal-title--sm"
          >
            {isEdit
              ? 'Edit Event'
              : initial?.subject
                ? 'Schedule Follow-up'
                : 'New Event'}
          </h2>
        </div>
        <form onSubmit={handleSubmit} className="create-event-form">
          <div className="crm-form-group">
            <div className="crm-form-field">
              <label
                htmlFor="create-event-subject"
                className="crm-form-label crm-form-label--required"
              >
                Subject
              </label>
              <input
                id="create-event-subject"
                ref={subjectInputRef}
                className="crm-form-input"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Meeting title"
              />
            </div>
            <div className="create-event-date-grid">
              <div className="crm-form-field">
                <label
                  htmlFor="create-event-date"
                  className="crm-form-label crm-form-label--required"
                >
                  Date
                </label>
                <input
                  id="create-event-date"
                  className="crm-form-input"
                  type="date"
                  value={date.toISOString().split('T')[0]}
                  onChange={(e) => {
                    const d = new Date(`${e.target.value}T00:00:00`);
                    if (!Number.isNaN(d.getTime())) setDate(d);
                  }}
                />
              </div>
              <div className="crm-form-field">
                <label
                  htmlFor="create-event-start"
                  className="crm-form-label crm-form-label--required"
                >
                  Start
                </label>
                <input
                  id="create-event-start"
                  className="crm-form-input"
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                />
              </div>
              <div className="crm-form-field">
                <label
                  htmlFor="create-event-end"
                  className="crm-form-label crm-form-label--required"
                >
                  End
                </label>
                <input
                  id="create-event-end"
                  className="crm-form-input"
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                />
              </div>
            </div>

            <div className="crm-form-field u-pos-relative">
              <label
                htmlFor="create-event-attendees"
                className="crm-form-label"
              >
                Attendees
              </label>
              <div className="create-event-attendees-wrap">
                {attendees.map((a) => (
                  <span key={a.email} className="create-event-attendee-chip">
                    {a.name || a.email}
                    <button
                      type="button"
                      onClick={() => removeAttendee(a.email)}
                      className="create-event-attendee-remove"
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  id="create-event-attendees"
                  ref={inputRef}
                  value={contactQuery}
                  onChange={(e) => {
                    setContactQuery(e.target.value);
                    setShowSuggestions(true);
                  }}
                  onFocus={() =>
                    contactQuery.length >= 2 && setShowSuggestions(true)
                  }
                  onKeyDown={handleKeyDown}
                  placeholder={
                    attendees.length ? '' : 'Type to search contacts...'
                  }
                  className="create-event-attendee-input"
                />
              </div>
              {showSuggestions && filteredSuggestions.length > 0 && (
                <div className="create-event-suggestions">
                  {filteredSuggestions.map((s) => (
                    <button
                      key={s.email}
                      type="button"
                      onClick={() => addAttendee(s.email, s.name)}
                      className="create-event-suggestion-btn"
                    >
                      <div>{s.name || s.email}</div>
                      {s.name && (
                        <div className="create-event-suggestion-email">
                          {s.email}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="crm-form-field">
              <label htmlFor="create-event-location" className="crm-form-label">
                Location
              </label>
              <input
                id="create-event-location"
                className="crm-form-input"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Room or link"
              />
            </div>
            <div className="crm-form-field">
              <label htmlFor="create-event-notes" className="crm-form-label">
                Notes
              </label>
              <textarea
                id="create-event-notes"
                className="crm-form-input create-event-notes-textarea"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Agenda or notes"
                rows={3}
              />
            </div>
          </div>
          <div className="create-event-footer">
            <button
              type="button"
              className="crm-btn crm-btn--secondary"
              onClick={onClose}
              disabled={isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={`crm-btn crm-btn--primary${!subject.trim() || isPending ? ' create-event-submit--disabled' : ''}`}
              disabled={!subject.trim() || isPending}
            >
              {isPending
                ? isEdit
                  ? 'Saving…'
                  : 'Creating…'
                : isEdit
                  ? 'Save Changes'
                  : 'Create Event'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
