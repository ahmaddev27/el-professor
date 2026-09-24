import React, { useState } from 'react';
import { LifeBuoy } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import {
  SUPPORT_REASON_MAX_LENGTH,
  supportReasonProblem,
} from '../lib/supportSession';
import { Button, cn } from './ui';

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

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  //
  // The dialog keeps its own overlay rather than becoming the design system's
  // Radix `Dialog`: that would add an Escape key and a focus trap this dialog
  // never had, and rewire `onCancel` through `onOpenChange`. Only the colours
  // moved. The confirm button is the brand fill because the design system has
  // no `caution` fill for a white label to read on; the tone is carried by the
  // icon, the title and the words, as it is everywhere else.
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(5_8_16/0.55)] p-4">
      <div
        className="w-full max-w-lg space-y-4 rounded-surface border border-line bg-overlay p-6 font-ui shadow-overlay"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center gap-3">
          <LifeBuoy size={22} className="text-caution" />
          <h2 className="text-lg font-semibold text-fg">
            {t('support.reason.title', { company: companyName })}
          </h2>
        </div>

        <p className="text-sm text-fg-muted">
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
            className={cn(
              'w-full rounded-control border bg-field px-3 py-2 text-sm text-fg placeholder:text-fg-subtle',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              showProblem ? 'border-critical' : 'border-line-strong',
            )}
          />
          <div className="flex justify-between text-xs">
            <span className="text-critical">
              {showProblem ? t(problem === 'empty' ? 'support.reason.required' : 'support.reason.tooLong') : ''}
            </span>
            <span className="tabular-nums text-fg-subtle">
              {reason.trim().length}/{SUPPORT_REASON_MAX_LENGTH}
            </span>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={onCancel}
            disabled={busy}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={busy}
          >
            {t('support.reason.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default SupportReasonModal;
