import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from '../../contexts/LanguageContext';
import { Button } from './Button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './Dialog';

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` for a destructive act (the default), `primary` otherwise. */
  tone?: 'danger' | 'primary';
  icon?: LucideIcon;
}

/**
 * "Are you sure?" on the design system, for the screens phase 5 moves across.
 *
 * It keeps the contract of the legacy `ConfirmationModal type="confirm"`, so
 * swapping one for the other changes the look and nothing a caller relies on:
 * the confirm button calls `onConfirm()` and then `onClose()`, in that order and
 * without awaiting, exactly as the old one did; everything else that closes it
 * — Abbrechen, the close button, Escape, a click outside — calls `onClose()`
 * alone. Escape and the click outside are new (the old overlay ignored both)
 * and both mean "no", which is what Abbrechen already meant.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = 'danger',
  icon: Icon,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">{cancelLabel ?? t('common.cancel')}</Button>
          </DialogClose>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {Icon ? <Icon aria-hidden /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
