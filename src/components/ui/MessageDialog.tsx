import type { ReactNode } from 'react';
import { CheckCircle2, Info, XCircle, type LucideIcon } from 'lucide-react';
import { useTranslation } from '../../contexts/LanguageContext';
import { Button } from './Button';
import { cn } from './cn';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './Dialog';

export type MessageDialogTone = 'positive' | 'critical' | 'brand';

export interface MessageDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called by OK, before `onClose` and unawaited, as the legacy modal did. */
  onConfirm?: () => void;
  title: ReactNode;
  description: ReactNode;
  tone?: MessageDialogTone;
}

const TONE_ICON: Record<MessageDialogTone, LucideIcon> = {
  positive: CheckCircle2,
  critical: XCircle,
  brand: Info,
};

const TONE_TEXT: Record<MessageDialogTone, string> = {
  positive: 'text-positive',
  critical: 'text-critical',
  brand: 'text-brand-text',
};

/**
 * A result the person has to acknowledge, on the design system: "saved",
 * "could not be deleted". The legacy `ConfirmationModal` with `type="success"`,
 * `"error"` or `"info"`, as ConfirmDialog is its `type="confirm"`.
 *
 * It keeps that modal's contract: OK calls `onConfirm()` and then `onClose()`,
 * in that order and without awaiting; the close button, Escape and a click
 * outside call `onClose()` alone, as the legacy close button did. Escape and the
 * click outside are new. A critical message is announced as an alert.
 */
export function MessageDialog({ open, onClose, onConfirm, title, description, tone = 'brand' }: MessageDialogProps) {
  const { t } = useTranslation();
  const Icon = TONE_ICON[tone];
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) onClose();
      }}
    >
      <DialogContent role={tone === 'critical' ? 'alertdialog' : 'dialog'}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <Icon aria-hidden className={cn('size-5 shrink-0', TONE_TEXT[tone])} />
            <span>{title}</span>
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            onClick={() => {
              if (onConfirm) onConfirm();
              onClose();
            }}
          >
            {t('common.ok')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
