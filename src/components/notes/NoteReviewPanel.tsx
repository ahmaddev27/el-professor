import { useState } from 'react';
import { format } from 'date-fns';
import { Paperclip } from 'lucide-react';
import { useTranslation } from '../../contexts/LanguageContext';
import { Alert, Badge, Button } from '../ui';
import type { ReviewDecision } from '../../lib/driverNoteProvenance';
import {
  EVIDENCE_EXTENSIONS,
  entrySourceOf,
  historyFields,
  readChangeLog,
  verificationOf,
  type NoteProvenance,
  type VerificationStatus,
} from '../../utils/noteProvenance';

/**
 * What a saved note says about itself: where it came from, whether anyone has
 * checked it, which document backs it, and what has changed since.
 *
 * Presentational. The writes belong to the screen (lib/driverNoteProvenance.ts),
 * and the database stamps the reviewer and the time, so nothing in here chooses
 * them. Colour is never the only signal: a status is a word and a tone.
 */

const TEXT = 'text-sm text-[var(--text-secondary)]';
const MUTED = 'text-xs text-[var(--text-tertiary)]';
const SECTION = 'rounded-lg border border-[var(--border)] p-3 space-y-2';
const HEADING = 'text-sm font-medium text-[var(--text-primary)]';
const ACCEPT = [
  ...EVIDENCE_EXTENSIONS.map(ext => `.${ext}`),
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
].join(',');

const STATUS_TONE: Record<VerificationStatus, 'neutral' | 'positive' | 'critical'> = {
  unverified: 'neutral',
  verified: 'positive',
  rejected: 'critical',
};

function stamp(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : format(date, 'dd.MM.yyyy HH:mm');
}

export interface NoteReviewPanelProps {
  provenance: NoteProvenance;
  /** Who wrote the note: the driver's name for one from the app, else the account's. */
  authorName: string;
  nameOf: (userId: string | null | undefined) => string;
  mayEdit: boolean;
  /** Whether a document is offered for this type (sick, vacation and off are a window, not an event). */
  evidenceOffered: boolean;
  busy: boolean;
  /** The unsaved edits change what a review covers, so saving takes the decision back. */
  willReset: boolean;
  onDecide: (decision: ReviewDecision) => void;
  onAttach: (file: File) => void;
  onOpenEvidence: () => void;
  onRemoveEvidence: () => void;
}

export function NoteReviewPanel(props: NoteReviewPanelProps) {
  const { provenance, mayEdit, busy } = props;
  const { t } = useTranslation();
  const status = verificationOf(provenance);

  return (
    <div className="space-y-3">
      <div className={SECTION}>
        <p className={TEXT}>
          {t('notes.prov.sourceLine', { source: t(`notes.prov.source.${entrySourceOf(provenance)}`) })}
          {' · '}
          {provenance.received_at
            ? t('notes.prov.receivedAt', { date: stamp(provenance.received_at) })
            : t('notes.prov.receivedUnknown')}
        </p>
        <p className={MUTED}>{t('notes.prov.authorLine', { name: props.authorName })}</p>
      </div>

      <ReviewSection {...props} status={status} t={t} />
      {(props.evidenceOffered || provenance.evidence_path) && <EvidenceSection {...props} t={t} />}
      <HistorySection {...props} mayEdit={mayEdit} busy={busy} t={t} />
    </div>
  );
}

type Translate = ReturnType<typeof useTranslation>['t'];

function ReviewSection(props: NoteReviewPanelProps & { status: VerificationStatus; t: Translate }) {
  const { provenance, status, mayEdit, busy, willReset, onDecide, nameOf, t } = props;
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  const decide = (decision: ReviewDecision) => {
    setRejecting(false);
    setReason('');
    onDecide(decision);
  };

  return (
    <div className={SECTION}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className={HEADING}>{t('notes.prov.review.title')}</h3>
        <Badge tone={STATUS_TONE[status]}>{t(`notes.prov.status.${status}`)}</Badge>
      </div>

      {status !== 'unverified' && (
        <p className={TEXT}>
          {t('notes.prov.review.line', {
            name: nameOf(provenance.reviewed_by),
            date: stamp(provenance.reviewed_at),
          })}
        </p>
      )}
      {status === 'rejected' && provenance.rejected_reason && (
        <p className={TEXT}>{t('notes.prov.review.reason', { reason: provenance.rejected_reason })}</p>
      )}
      <p className={MUTED}>{t('notes.prov.review.hint')}</p>

      {status !== 'unverified' && willReset && (
        <Alert tone="caution" role="status">{t('notes.prov.review.resetWarning')}</Alert>
      )}

      {mayEdit && !rejecting && (
        <div className="flex flex-wrap gap-2">
          {status !== 'verified' && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => decide({ status: 'verified' })}>
              {t('notes.prov.action.verify')}
            </Button>
          )}
          {status !== 'rejected' && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setRejecting(true)}>
              {t('notes.prov.action.reject')}
            </Button>
          )}
          {status !== 'unverified' && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => decide({ status: 'unverified' })}>
              {t('notes.prov.action.retract')}
            </Button>
          )}
        </div>
      )}

      {mayEdit && rejecting && (
        <div className="space-y-2">
          <label htmlFor="note-reject-reason" className="block text-xs font-medium text-[var(--text-tertiary)]">
            {t('notes.prov.action.reasonLabel')}
          </label>
          <textarea
            id="note-reject-reason"
            rows={2}
            value={reason}
            onChange={event => setReason(event.target.value)}
            className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="danger"
              disabled={busy || reason.trim() === ''}
              onClick={() => decide({ status: 'rejected', reason })}
            >
              {t('notes.prov.action.confirmReject')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setRejecting(false); setReason(''); }}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function EvidenceSection(props: NoteReviewPanelProps & { t: Translate }) {
  const { provenance, mayEdit, busy, onAttach, onOpenEvidence, onRemoveEvidence, t } = props;
  const attached = Boolean(provenance.evidence_path);

  return (
    <div className={SECTION}>
      <h3 className={HEADING}>{t('notes.prov.evidence.title')}</h3>
      {attached ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="brand"><Paperclip aria-hidden />{t('notes.prov.chip.evidence')}</Badge>
          <Button size="sm" variant="secondary" disabled={busy} onClick={onOpenEvidence}>
            {t('notes.prov.evidence.open')}
          </Button>
          {mayEdit && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onRemoveEvidence}>
              {t('notes.prov.evidence.remove')}
            </Button>
          )}
        </div>
      ) : (
        <p className={TEXT}>{t('notes.prov.evidence.none')}</p>
      )}
      {!attached && mayEdit && (
        <div>
          <label htmlFor="note-evidence-file" className="block text-xs font-medium mb-1 text-[var(--text-tertiary)]">
            {t('notes.prov.evidence.attach')}
          </label>
          <input
            id="note-evidence-file"
            type="file"
            accept={ACCEPT}
            disabled={busy}
            onChange={event => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) onAttach(file);
            }}
            className="block w-full text-sm text-[var(--text-secondary)]"
          />
          <p className={MUTED}>{t('notes.prov.evidence.hint')}</p>
        </div>
      )}
    </div>
  );
}

function HistorySection(props: NoteReviewPanelProps & { t: Translate }) {
  const { provenance, nameOf, t } = props;
  const entries = readChangeLog(provenance.change_log).slice().reverse();

  return (
    <details className={SECTION}>
      <summary className={`cursor-pointer ${HEADING}`}>{t('notes.prov.history.title')}</summary>
      {entries.length === 0 ? (
        <p className={MUTED}>{t('notes.prov.history.empty')}</p>
      ) : (
        <ul className="space-y-1">
          {entries.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className={TEXT}>
              {t('notes.prov.history.entry', {
                date: stamp(entry.at),
                name: entry.by ? nameOf(entry.by) : t('notes.prov.history.system'),
                fields: historyFields(entry.changed).map(field => t(`notes.prov.field.${field}`)).join(', '),
              })}
              {entry.verificationReset && <span className={MUTED}>{' · '}{t('notes.prov.history.reset')}</span>}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
