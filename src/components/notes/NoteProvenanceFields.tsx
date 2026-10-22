import { useState } from 'react';
import { useTranslation } from '../../contexts/LanguageContext';
import type { ProvenanceFormValues } from '../../utils/noteProvenance';

/**
 * The optional part of the Notizen form that says when the event happened, when
 * it was reported, and where. Nothing in it changes the planning, and the
 * section says so before anyone fills it in.
 *
 * The classes carry the legacy variables the surrounding dialog uses, not inline
 * styles: the screen is not converted yet and the style ratchet is at its
 * baseline (the vehicle picker beside it does the same).
 */

const INPUT =
  'w-full rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none';
const LABEL = 'block text-xs font-medium mb-1 text-[var(--text-tertiary)]';
const HINT = 'mt-1 text-xs text-[var(--text-tertiary)]';

export interface NoteProvenanceFieldsProps {
  values: ProvenanceFormValues;
  onChange: (patch: Partial<ProvenanceFormValues>) => void;
}

export function NoteProvenanceFields({ values, onChange }: NoteProvenanceFieldsProps) {
  const { t } = useTranslation();
  // Open when the note already says something here, closed otherwise; after that
  // the person decides. Held in state because a controlled `open` would close the
  // section under the cursor the moment the last field is cleared.
  const [open, setOpen] = useState(Object.values(values).some(value => value !== ''));

  return (
    <details
      open={open}
      onToggle={event => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      className="rounded-lg border border-[var(--border)] p-3"
    >
      <summary className="cursor-pointer text-sm font-medium text-[var(--text-secondary)]">
        {t('notes.prov.section')}
      </summary>
      <p className={HINT}>{t('notes.prov.sectionHint')}</p>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="note-occurred-at" className={LABEL}>{t('notes.prov.occurredAt')}</label>
          <input
            id="note-occurred-at"
            type="datetime-local"
            value={values.occurred_at}
            onChange={event => onChange({ occurred_at: event.target.value })}
            className={INPUT}
          />
          <p className={HINT}>{t('notes.prov.occurredAtHint')}</p>
        </div>
        <div>
          <label htmlFor="note-reported-at" className={LABEL}>{t('notes.prov.reportedAt')}</label>
          <input
            id="note-reported-at"
            type="datetime-local"
            value={values.reported_at}
            onChange={event => onChange({ reported_at: event.target.value })}
            className={INPUT}
          />
          <p className={HINT}>{t('notes.prov.reportedAtHint')}</p>
        </div>
      </div>

      <fieldset className="mt-3">
        <legend className="mb-1 text-xs font-medium text-[var(--text-tertiary)]">{t('notes.prov.position')}</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="note-latitude" className={LABEL}>{t('notes.prov.latitude')}</label>
            <input
              id="note-latitude"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={values.latitude}
              onChange={event => onChange({ latitude: event.target.value })}
              className={INPUT}
            />
          </div>
          <div>
            <label htmlFor="note-longitude" className={LABEL}>{t('notes.prov.longitude')}</label>
            <input
              id="note-longitude"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={values.longitude}
              onChange={event => onChange({ longitude: event.target.value })}
              className={INPUT}
            />
          </div>
          <div>
            <label htmlFor="note-accuracy" className={LABEL}>{t('notes.prov.accuracy')}</label>
            <input
              id="note-accuracy"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={values.location_accuracy_m}
              onChange={event => onChange({ location_accuracy_m: event.target.value })}
              className={INPUT}
            />
          </div>
        </div>
        <p className={HINT}>{t('notes.prov.positionHint')}</p>
      </fieldset>
    </details>
  );
}
