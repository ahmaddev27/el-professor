/**
 * Deleting a driver for good, in three steps that each say what is going on
 * (owner, 27.11.2026, reversing "Fahrer werden deaktiviert, nicht gelöscht").
 *
 * 1. Ask the database whether anything refers to the driver (`driver_delete_check`).
 * 2. Nothing does: a destructive confirmation that names the driver and says it
 *    cannot be undone. Something does: the areas it is in, and Deaktivieren
 *    instead, because a driver with history is part of the records.
 * 3. Delete through `deleteChecked`, because a DELETE the policy hides answers
 *    200 with no rows and would otherwise read as a success.
 *
 * The check is courtesy. The trigger on `drivers` refuses the delete whatever
 * this dialog did, so a reference that appears between the question and the
 * delete lands on the same list of areas instead of an error toast.
 */
import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../contexts/ToastContext';
import { useTranslation } from '../../contexts/LanguageContext';
import {
  AREA_KEYS, blockerAreas, checkDriverDelete, deleteDriver, type AreaCount,
} from '../../lib/driverDelete';
import { isDeactivatedDriver } from '../../utils/driverStatus';
import type { Driver } from '../../types/receipt';
import type { TranslationKey } from '../../i18n';
import {
  Button, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../ui';

type Phase =
  | { kind: 'checking' }
  | { kind: 'confirm' }
  | { kind: 'blocked'; areas: AreaCount[] };

interface DriverDeleteDialogProps {
  /** The driver whose bin was pressed; null while nothing is open. */
  driver: Driver | null;
  onClose: () => void;
  /** The driver is gone (or was already): the page reads its list again. */
  onChanged: () => void;
  /** Deaktivieren, offered when the driver cannot be deleted. Absent: no button. */
  onDeactivate?: (driver: Driver) => void;
}

export function DriverDeleteDialog({ driver, onClose, onChanged, onDeactivate }: DriverDeleteDialogProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [phase, setPhase] = useState<Phase | null>(null);
  const deleting = useRef(false);
  const driverId = driver?.id ?? null;

  useEffect(() => {
    if (!driverId) { setPhase(null); return; }
    let current = true;
    setPhase({ kind: 'checking' });
    void checkDriverDelete(supabase, driverId).then(check => {
      if (!current) return;
      if (check?.kind === 'deletable') setPhase({ kind: 'confirm' });
      else if (check?.kind === 'blocked') setPhase({ kind: 'blocked', areas: blockerAreas(check.blockers) });
      else if (check?.kind === 'refused' && check.reason === 'driver_not_found') finish('common.writeAlreadyGone', true);
      else finish(check?.kind === 'refused' ? 'common.writeRefused' : 'fahrer.delete.checkFailed');
    }).catch(() => { if (current) finish('fahrer.delete.checkFailed'); });
    return () => { current = false; };
    // `finish` only reads props that are stable for one open dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driverId]);

  function finish(messageKey: TranslationKey, reload = false) {
    showToast('error', t(messageKey));
    if (reload) onChanged();
    onClose();
  }

  const runDelete = async () => {
    if (!driver || deleting.current) return;
    deleting.current = true;
    try {
      const result = await deleteDriver(supabase, driver.id);
      if (result === 'done') { showToast('success', t('fahrer.delete.done', { name: driver.name })); onChanged(); onClose(); }
      else if (result === 'refused') finish('common.writeRefused');
      else if (result === 'gone') finish('common.writeAlreadyGone', true);
      else await showWhatRefers();
    } catch {
      finish('fahrer.delete.failed');
    } finally {
      deleting.current = false;
    }
  };

  /** A reference appeared after the check: ask again and show the areas. */
  const showWhatRefers = async () => {
    const check = driver ? await checkDriverDelete(supabase, driver.id) : null;
    if (check?.kind === 'blocked') setPhase({ kind: 'blocked', areas: blockerAreas(check.blockers) });
    else finish('fahrer.delete.failed');
  };

  if (!driver || !phase || phase.kind === 'checking') return null;

  if (phase.kind === 'confirm') {
    return (
      <ConfirmDialog
        open
        title={t('fahrer.delete.confirmTitle')}
        description={t('fahrer.delete.confirmBody', { name: driver.name })}
        confirmLabel={t('fahrer.delete.confirmAction')}
        icon={Trash2}
        onConfirm={() => void runDelete()}
        // The confirm button closes the dialog right after calling onConfirm;
        // a delete that is still running must not lose its dialog (it may have
        // to turn into the list of what refers to the driver).
        onClose={() => { if (!deleting.current) onClose(); }}
      />
    );
  }

  const inactive = isDeactivatedDriver(driver);
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('fahrer.delete.blockedTitle', { name: driver.name })}</DialogTitle>
          <DialogDescription>{t('fahrer.delete.blockedBody')}</DialogDescription>
        </DialogHeader>
        <ul className="grid gap-1 text-sm text-fg">
          {phase.areas.length === 0
            ? <li>{t(AREA_KEYS.other)}</li>
            : phase.areas.map(({ area, rows }) => (
              <li key={area} className="flex justify-between gap-3">
                <span>{t(AREA_KEYS[area])}</span>
                <span className="tabular-nums text-fg-muted">{rows}</span>
              </li>
            ))}
        </ul>
        <p className="text-sm text-fg-muted">
          {inactive ? t('fahrer.delete.alreadyDeactivated') : t('fahrer.delete.deactivateInstead')}
        </p>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>{t('common.close')}</Button>
          {!inactive && onDeactivate ? (
            <Button onClick={() => { onDeactivate(driver); onClose(); }}>{t('fleet.deactivate')}</Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
