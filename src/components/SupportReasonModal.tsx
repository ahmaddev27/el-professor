import React, { useState } from 'react';
import { LifeBuoy } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import {
  SUPPORT_REASON_MAX_LENGTH,
  supportReasonProblem,
} from '../lib/supportSession';

interface Props {
  companyName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

/**
 * The reason a support session is opened with (plan 3.C).
 *
 * `app_private.platform_company_contexts.reason` is NOT NULL for mode
 * `support`, capped at 500 characters, and it is written into the audit log
 * with the row — it is the record of why someone reached into a customer's
 * data. So it is asked for in the words of the person opening the session, and
 * never filled in for them.
 *
 * The same rule is checked here and in the database: `platform_context_open`
 * trims the value and refuses an empty one with `reason_required`. Checking it
 * here saves the round trip and says which of the two problems it is; it
 * decides nothing.
 */
const SupportReasonModal: React.FC<Props> = ({ companyName, busy, onCancel, onConfirm }) => {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  const problem = supportReasonProblem(reason);
  const showProblem = touched && problem !== null;

  const submit = () => {
    setTouched(true);
    if (problem !== null) return;
    onConfirm(reason);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}>
      <div
        className="w-full max-w-lg rounded-2xl p-6 space-y-4"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center gap-3">
          <LifeBuoy size={22} style={{ color: 'var(--warning)' }} />
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
            {t('support.reason.title', { company: companyName })}
          </h2>
        </div>

        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {t('support.reason.body')}
        </p>

        <div className="space-y-1">
          <textarea
            value={reason}
            autoFocus
            rows={3}
            maxLength={SUPPORT_REASON_MAX_LENGTH}
            onChange={event => setReason(event.target.value)}
            onBlur={() => setTouched(true)}
            placeholder={t('support.reason.placeholder')}
            className="w-full rounded-xl px-3 py-2 text-sm"
            style={{
              background: 'var(--bg-subtle)',
              border: `1px solid ${showProblem ? 'var(--danger)' : 'var(--border)'}`,
              color: 'var(--text-primary)',
            }}
          />
          <div className="flex justify-between text-xs">
            <span style={{ color: 'var(--danger)' }}>
              {showProblem ? t(problem === 'empty' ? 'support.reason.required' : 'support.reason.tooLong') : ''}
            </span>
            <span className="tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
              {reason.trim().length}/{SUPPORT_REASON_MAX_LENGTH}
            </span>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 rounded-xl text-sm font-medium disabled:opacity-50"
            style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-50"
            // --warning-solid with white on it: --warning is a text colour and
            // fails contrast as a fill, and --text-inverse flips to near-black
            // in dark mode. accentLabel.contrast.test.ts is the rule.
            style={{ background: 'var(--warning-solid)', color: '#ffffff' }}
          >
            {t('support.reason.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SupportReasonModal;
