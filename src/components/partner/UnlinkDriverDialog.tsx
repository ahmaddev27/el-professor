/**
 * Taking a Reidey link apart (owner, 28.11.2026), automatic links included.
 *
 * The dialog says the three things the act does and does not do before it is
 * done: the driver stops receiving what Reidey sends; what is already with the
 * driver stays with them; and no automatic path links the Reidey driver again,
 * so it waits under "Entscheiden" for a person. The database is the rule
 * (`partner_driver_link_unlink`); this only asks and reports.
 *
 * A `Dialog` rather than `ConfirmDialog`: it stays open while the call runs and
 * after a failure, so a second press is a retry rather than a new dialog.
 */
import { useRef, useState } from 'react';
import { Unlink } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../contexts/ToastContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { unlinkPartnerDriver } from '../../lib/partnerDriverLinks';
import type { Driver } from '../../types/receipt';
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../ui';

export interface UnlinkTarget {
  driver: Driver;
  linkId: string;
}

interface UnlinkDriverDialogProps {
  /** The driver whose unlink button was pressed; null while nothing is open. */
  target: UnlinkTarget | null;
  onClose: () => void;
  /** The link is gone (or was already): the page reads its links again. */
  onUnlinked: () => void;
}

export function UnlinkDriverDialog({ target, onClose, onUnlinked }: UnlinkDriverDialogProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  if (!target) return null;
  const name = target.driver.name;

  const run = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const outcome = await unlinkPartnerDriver(supabase, target.linkId);
      if (outcome.kind === 'done') {
        showToast('success', t('partner.links.unlink.done', { name }));
        onUnlinked();
        onClose();
      } else if (outcome.kind === 'refused') {
        showToast('error', t(outcome.messageKey));
        if (outcome.reload) onUnlinked();
        onClose();
      } else {
        showToast('error', t('partner.links.unlink.failed'));
      }
    } catch {
      showToast('error', t('partner.links.unlink.failed'));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={open => { if (!open && !running.current) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('partner.links.unlink.title', { name })}</DialogTitle>
          <DialogDescription>{t('partner.links.unlink.body', { name })}</DialogDescription>
        </DialogHeader>
        <ul className="grid list-disc gap-2 ps-5 text-sm text-fg">
          <li>{t('partner.links.unlink.recordsStay', { name })}</li>
          <li>{t('partner.links.unlink.noAutoRelink')}</li>
          <li>{t('partner.links.unlink.relinkByHand')}</li>
        </ul>
        <DialogFooter>
          <Button variant="secondary" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" disabled={busy} onClick={() => void run()}>
            <Unlink aria-hidden />
            {t('partner.links.unlink.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
