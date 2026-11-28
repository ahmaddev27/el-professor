/**
 * "N drivers need a decision": the compact notice above the Fahrer list that
 * replaced the Verknüpfungsvorschläge tab (27.11.2026). It appears only while
 * something waits, and its button opens the confirm/reject table in a dialog.
 */
import { useState } from 'react';
import { Link2 } from 'lucide-react';
import { useTranslation } from '../../contexts/LanguageContext';
import type { Driver } from '../../types/receipt';
import { Alert, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui';
import { PartnerLinkProposals } from './PartnerLinkProposals';

interface PendingLinksNoticeProps {
  count: number;
  companyId: string | null;
  drivers: Driver[];
  onDecided: () => void;
}

export function PendingLinksNotice({ count, companyId, drivers, onDecided }: PendingLinksNoticeProps) {
  const { t, tPlural } = useTranslation();
  const [open, setOpen] = useState(false);
  if (count <= 0) return null;
  return (
    <>
      <Alert
        tone="caution"
        icon={Link2}
        role="note"
        title={tPlural({ one: 'drivers.pending.title.one', other: 'drivers.pending.title.other' }, count, { count })}
        action={<Button size="sm" variant="secondary" onClick={() => setOpen(true)}>{t('drivers.pending.open')}</Button>}
      >
        {t('drivers.pending.body')}
      </Alert>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>{t('drivers.pending.dialogTitle')}</DialogTitle>
            <DialogDescription>{t('drivers.pending.dialogBody')}</DialogDescription>
          </DialogHeader>
          <PartnerLinkProposals companyId={companyId} drivers={drivers} onDecided={onDecided} />
        </DialogContent>
      </Dialog>
    </>
  );
}
