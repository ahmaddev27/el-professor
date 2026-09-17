import { useCallback, useRef, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationVars } from '../i18n';
import type { TranslationKey } from '../i18n';
import { cn } from './ui';
import { REFUSAL_MESSAGE_KEYS, SIGNED_COPY_ACCEPT, type ReceiptActionRefusal } from '../utils/salaryCashReceiptFlow';
import type { ReceiptDocumentProblem } from '../utils/salaryCashReceiptDocument';

/** Pieces the Gehaltsquittung dialog and the receipt list share. */

const ALERT_TONES = {
  critical: 'border-critical/30 bg-critical-soft text-critical',
  caution: 'border-caution/30 bg-caution-soft text-caution',
  positive: 'border-positive/30 bg-positive-soft text-positive',
} as const;

export interface ReceiptAlertProps {
  tone: keyof typeof ALERT_TONES;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}

/** A message in the flow. Critical ones are announced at once; the others politely. */
export function ReceiptAlert({ tone, title, children, action }: ReceiptAlertProps) {
  const Icon = tone === 'positive' ? CheckCircle2 : AlertTriangle;
  return (
    <div
      role={tone === 'critical' ? 'alert' : 'status'}
      className={cn('flex items-start gap-2.5 rounded-control border p-3 font-ui text-sm', ALERT_TONES[tone])}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="grid min-w-0 gap-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div>{children}</div> : null}
        {action ? <div className="mt-1">{action}</div> : null}
      </div>
    </div>
  );
}

/** A refusal's message in the UI language. */
export function useRefusalMessage() {
  const { t } = useTranslation();
  return useCallback(
    (refusal: ReceiptActionRefusal, vars?: TranslationVars) => t(REFUSAL_MESSAGE_KEYS[refusal], vars),
    [t],
  );
}

const DOCUMENT_PROBLEM_KEYS: Record<ReceiptDocumentProblem, TranslationKey> = {
  missing_company_name: 'gq.pdf.missingCompanyName',
  missing_driver_name: 'gq.pdf.missingDriverName',
};

/** Why a receipt cannot be printed, in the UI language. */
export function useDocumentProblemMessage() {
  const { t } = useTranslation();
  return useCallback((problem: ReceiptDocumentProblem) => t(DOCUMENT_PROBLEM_KEYS[problem]), [t]);
}

/**
 * One hidden file input for signed copies, opened from any button. The value
 * is cleared after each pick, so the same file can be chosen again after a
 * failed upload.
 */
export function useSignedCopyPicker() {
  const inputRef = useRef<HTMLInputElement>(null);
  const handlerRef = useRef<((file: File) => void) | null>(null);

  const pick = useCallback((onFile: (file: File) => void) => {
    handlerRef.current = onFile;
    inputRef.current?.click();
  }, []);

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept={SIGNED_COPY_ACCEPT}
      hidden
      onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) handlerRef.current?.(file);
      }}
    />
  );

  return { input, pick };
}
