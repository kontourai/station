import { useEffect, useRef, useState } from 'react';
import { useTopmostModal } from './components/useTopmostModal';
import { useCreateOpportunity, useCreateTask } from './data';
import type { AccountVM, OpportunityVM, TaskVM } from './data/viewmodels';

// ─── Create Opportunity Modal ─────────────────────────────────────────────────

interface CreateOpportunityModalProps {
  isOpen: boolean;
  account: AccountVM | null;
  onClose: () => void;
  onCreated?: (opp: OpportunityVM) => void;
}

export function CreateOpportunityModal({
  isOpen,
  account,
  onClose,
  onCreated,
}: CreateOpportunityModalProps) {
  const createOpp = useCreateOpportunity();
  const [name, setName] = useState('');
  const [stage, setStage] = useState('Prospecting');
  const [amount, setAmount] = useState('');
  const [closeDate, setCloseDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const { dialogRef, onKeyDown } = useTopmostModal({
    isOpen,
    onClose,
    initialFocusRef: nameInputRef,
  });

  useEffect(() => {
    if (!isOpen) {
      setName('');
      setStage('Prospecting');
      setAmount('');
      setCloseDate('');
      setError(null);
    }
  }, [isOpen]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    try {
      const opp = await createOpp.mutateAsync({
        name: name.trim(),
        accountId: account?.id,
        stage,
        amount: amount ? Number(amount) : undefined,
        closeDate: closeDate ? new Date(closeDate) : undefined,
      });
      onCreated?.(opp);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to create opportunity',
      );
    }
  }

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <button
        type="button"
        className="enterprise-modal-backdrop enterprise-modal-backdrop--fill"
        tabIndex={-1}
        aria-label="Close dialog"
        onClick={onClose}
      />
      <div
        className="modal-dialog enterprise-modal-layer"
        ref={dialogRef}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-opp-title"
      >
        <div className="modal-header">
          <h3 id="create-opp-title">New Opportunity</h3>
          {account && <div className="modal-subtitle">{account.name}</div>}
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="modal-error">{error}</div>}
            <label className="form-field">
              <span className="form-label">Name *</span>
              <input
                ref={nameInputRef}
                className="form-input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </label>
            <label className="form-field">
              <span className="form-label">Stage</span>
              <select
                className="form-input"
                value={stage}
                onChange={(e) => setStage(e.target.value)}
              >
                <option>Prospecting</option>
                <option>Qualification</option>
                <option>Needs Analysis</option>
                <option>Value Proposition</option>
                <option>Decision Makers</option>
                <option>Perception Analysis</option>
                <option>Proposal/Price Quote</option>
                <option>Negotiation/Review</option>
                <option>Closed Won</option>
                <option>Closed Lost</option>
              </select>
            </label>
            <label className="form-field">
              <span className="form-label">Amount</span>
              <input
                className="form-input"
                type="number"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
              />
            </label>
            <label className="form-field">
              <span className="form-label">Close Date</span>
              <input
                className="form-input"
                type="date"
                value={closeDate}
                onChange={(e) => setCloseDate(e.target.value)}
              />
            </label>
          </div>
          <div className="modal-footer">
            <button
              type="button"
              className="btn btn--secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={createOpp.isPending}
            >
              {createOpp.isPending ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Log Activity Modal ───────────────────────────────────────────────────────

interface LogActivityModalProps {
  isOpen: boolean;
  account: AccountVM | null;
  opportunities: OpportunityVM[];
  onClose: () => void;
  onLogged?: (task: TaskVM) => void;
}

const ACTIVITY_TYPES = [
  'Call',
  'Email',
  'Meeting',
  'Demo',
  'Follow-up',
  'Other',
];

export function LogActivityModal({
  isOpen,
  account,
  opportunities,
  onClose,
  onLogged,
}: LogActivityModalProps) {
  const createTask = useCreateTask();
  const [subject, setSubject] = useState('');
  const [activityType, setActivityType] = useState('Call');
  const [description, setDescription] = useState('');
  const [relatedOppId, setRelatedOppId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const subjectInputRef = useRef<HTMLInputElement>(null);

  const { dialogRef, onKeyDown } = useTopmostModal({
    isOpen,
    onClose,
    initialFocusRef: subjectInputRef,
  });

  useEffect(() => {
    if (!isOpen) {
      setSubject('');
      setActivityType('Call');
      setDescription('');
      setRelatedOppId('');
      setDueDate('');
      setError(null);
    }
  }, [isOpen]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim()) {
      setError('Subject is required');
      return;
    }
    try {
      const relatedTo = relatedOppId
        ? {
            type: 'Opportunity',
            id: relatedOppId,
            name:
              opportunities.find((o) => o.id === relatedOppId)?.name ??
              relatedOppId,
          }
        : account
          ? { type: 'Account', id: account.id, name: account.name }
          : undefined;

      const task = await createTask.mutateAsync({
        subject: subject.trim(),
        status: 'completed',
        activityType,
        description,
        dueDate: dueDate ? new Date(dueDate) : undefined,
        relatedTo,
      });
      onLogged?.(task);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to log activity');
    }
  }

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <button
        type="button"
        className="enterprise-modal-backdrop enterprise-modal-backdrop--fill"
        tabIndex={-1}
        aria-label="Close dialog"
        onClick={onClose}
      />
      <div
        className="modal-dialog enterprise-modal-layer"
        ref={dialogRef}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby="log-activity-title"
      >
        <div className="modal-header">
          <h3 id="log-activity-title">Log Activity</h3>
          {account && <div className="modal-subtitle">{account.name}</div>}
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="modal-error">{error}</div>}
            <label className="form-field">
              <span className="form-label">Subject *</span>
              <input
                ref={subjectInputRef}
                className="form-input"
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                required
              />
            </label>
            <label className="form-field">
              <span className="form-label">Activity Type</span>
              <select
                className="form-input"
                value={activityType}
                onChange={(e) => setActivityType(e.target.value)}
              >
                {ACTIVITY_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            {opportunities.length > 0 && (
              <label className="form-field">
                <span className="form-label">Related Opportunity</span>
                <select
                  className="form-input"
                  value={relatedOppId}
                  onChange={(e) => setRelatedOppId(e.target.value)}
                >
                  <option value="">— None —</option>
                  {opportunities.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="form-field">
              <span className="form-label">Due Date</span>
              <input
                className="form-input"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </label>
            <label className="form-field">
              <span className="form-label">Notes</span>
              <textarea
                className="form-input form-textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
              />
            </label>
          </div>
          <div className="modal-footer">
            <button
              type="button"
              className="btn btn--secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={createTask.isPending}
            >
              {createTask.isPending ? 'Logging…' : 'Log Activity'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Create Task Modal ────────────────────────────────────────────────────────

interface CreateTaskModalProps {
  isOpen: boolean;
  account: AccountVM | null;
  onClose: () => void;
  onCreated?: (task: TaskVM) => void;
}

export function CreateTaskModal({
  isOpen,
  account,
  onClose,
  onCreated,
}: CreateTaskModalProps) {
  const createTask = useCreateTask();
  const [subject, setSubject] = useState('');
  const [priority, setPriority] = useState<'high' | 'normal' | 'low'>('normal');
  const [dueDate, setDueDate] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const subjectInputRef = useRef<HTMLInputElement>(null);

  const { dialogRef, onKeyDown } = useTopmostModal({
    isOpen,
    onClose,
    initialFocusRef: subjectInputRef,
  });

  useEffect(() => {
    if (!isOpen) {
      setSubject('');
      setPriority('normal');
      setDueDate('');
      setDescription('');
      setError(null);
    }
  }, [isOpen]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim()) {
      setError('Subject is required');
      return;
    }
    try {
      const task = await createTask.mutateAsync({
        subject: subject.trim(),
        status: 'open',
        priority,
        dueDate: dueDate ? new Date(dueDate) : undefined,
        description,
        relatedTo: account
          ? { type: 'Account', id: account.id, name: account.name }
          : undefined,
      });
      onCreated?.(task);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    }
  }

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <button
        type="button"
        className="enterprise-modal-backdrop enterprise-modal-backdrop--fill"
        tabIndex={-1}
        aria-label="Close dialog"
        onClick={onClose}
      />
      <div
        className="modal-dialog enterprise-modal-layer"
        ref={dialogRef}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-task-title"
      >
        <div className="modal-header">
          <h3 id="create-task-title">New Task</h3>
          {account && <div className="modal-subtitle">{account.name}</div>}
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="modal-error">{error}</div>}
            <label className="form-field">
              <span className="form-label">Subject *</span>
              <input
                ref={subjectInputRef}
                className="form-input"
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                required
              />
            </label>
            <label className="form-field">
              <span className="form-label">Priority</span>
              <select
                className="form-input"
                value={priority}
                onChange={(e) =>
                  setPriority(e.target.value as 'high' | 'normal' | 'low')
                }
              >
                <option value="high">High</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </select>
            </label>
            <label className="form-field">
              <span className="form-label">Due Date</span>
              <input
                className="form-input"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </label>
            <label className="form-field">
              <span className="form-label">Description</span>
              <textarea
                className="form-input form-textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </label>
          </div>
          <div className="modal-footer">
            <button
              type="button"
              className="btn btn--secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={createTask.isPending}
            >
              {createTask.isPending ? 'Creating…' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
