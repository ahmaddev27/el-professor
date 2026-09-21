import React, { useState, useEffect } from 'react';
import { Save, RefreshCw } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import type { CarWithDrivers } from '../types/car';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import {
  Button,
  cn,
  Field,
  Input,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Skeleton,
  Tooltip,
} from './ui';

/** Ties the footer's save button, outside the scrolling body, to the form. */
const FORM_ID = 'car-form';

interface Driver {
  id: string;
  name: string;
}

interface CarModalProps {
  car: CarWithDrivers | null;
  onClose: () => void;
  onSuccess: () => void;
}

function defaultTuevDate(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().split('T')[0];
}

export default function CarModal({ car, onClose, onSuccess }: CarModalProps) {
  const [kennzeichen, setKennzeichen] = useState(car?.kennzeichen || '');
  const [tuevGueltigBis, setTuevGueltigBis] = useState(
    car?.tuev_gueltig_bis || defaultTuevDate()
  );
  const [letzteHu, setLetzteHu] = useState(car?.letzte_hu || '');
  const [selectedDriverIds, setSelectedDriverIds] = useState<string[]>(
    car?.drivers.map(d => d.id) || []
  );
  const [availableDrivers, setAvailableDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingDrivers, setLoadingDrivers] = useState(true);
  const { user } = useAuth();
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const { showToast } = useToast();
  const { t } = useTranslation();

  useEffect(() => { loadDrivers(); }, []);

  const loadDrivers = async () => {
    try {
      setLoadingDrivers(true);
      const { data, error } = await supabase
        .from('drivers')
        .select('id, name, status')
        .eq('company_id', companyId)
        .eq('status', 'active')
        .order('name');
      if (error) throw error;
      setAvailableDrivers(data || []);
    } catch (error: any) {
      showToast('error', t('fleet.driversLoadFailed', { error: error.message }));
    } finally {
      setLoadingDrivers(false);
    }
  };

  const handleDriverToggle = (driverId: string) => {
    setSelectedDriverIds(prev => {
      if (prev.includes(driverId)) return prev.filter(id => id !== driverId);
      if (prev.length >= 2) {
        showToast('error', t('fleet.maxTwoDrivers'));
        return prev;
      }
      return [...prev, driverId];
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!kennzeichen.trim()) { showToast('error', t('fleet.kennzeichenRequired')); return; }
    if (!user) { showToast('error', t('fleet.mustBeSignedIn')); return; }

    try {
      setLoading(true);
      const carData = {
        kennzeichen:      kennzeichen.trim().toUpperCase(),
        tuev_gueltig_bis: tuevGueltigBis || null,
        letzte_hu:        letzteHu || null,
      };

      if (car) {
        const { error: updateError } = await supabase.from('cars').update(carData).eq('id', car.id);
        if (updateError) throw updateError;

        const { error: deleteError } = await supabase.from('car_driver_assignments').delete().eq('car_id', car.id);
        if (deleteError) throw deleteError;

        if (selectedDriverIds.length > 0) {
          const { error: insertError } = await supabase.from('car_driver_assignments').insert(
            selectedDriverIds.map(driverId => ({ car_id: car.id, driver_id: driverId, created_by: user.id, company_id: companyId }))
          );
          if (insertError) throw insertError;
        }
        showToast('success', t('fleet.carUpdated'));
      } else {
        const { data: newCar, error: carError } = await supabase
          .from('cars').insert({ ...carData, created_by: user.id, company_id: companyId }).select().single();
        if (carError) throw carError;

        if (selectedDriverIds.length > 0 && newCar) {
          const { error: assignmentError } = await supabase.from('car_driver_assignments').insert(
            selectedDriverIds.map(driverId => ({ car_id: newCar.id, driver_id: driverId, created_by: user.id, company_id: companyId }))
          );
          if (assignmentError) throw assignmentError;
        }
        showToast('success', t('fleet.carCreated'));
      }
      onSuccess();
    } catch (error: any) {
      if (error.message.includes('duplicate key')) {
        showToast('error', t('fleet.kennzeichenExists'));
      } else if (error.message.includes('maximum 2 drivers')) {
        showToast('error', t('fleet.maxTwoDrivers'));
      } else {
        showToast('error', t('fleet.saveFailed', { error: error.message }));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRenewTuev = () => {
    const base = tuevGueltigBis ? new Date(tuevGueltigBis) : new Date();
    base.setFullYear(base.getFullYear() + 1);
    setTuevGueltigBis(base.toISOString().split('T')[0]);
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the form's logic and is unchanged. The one piece of it
  // that sat inside the markup — which driver rows are selected and which are
  // locked because two are already chosen — is kept below word for word.

  return (
    <Sheet
      open
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        // A click beside the form must not throw away what was typed; the old
        // modal ignored it as well. Escape and the close button still close.
        onInteractOutside={event => event.preventDefault()}
      >
        <SheetHeader>
          <SheetTitle>{car ? t('fleet.editCar') : t('fleet.newCar')}</SheetTitle>
          <SheetDescription>{t('fleet.carFormDescription')}</SheetDescription>
        </SheetHeader>

        <SheetBody>
          <form id={FORM_ID} onSubmit={handleSubmit} className="grid gap-6">
            <Field label={t('werkstatt.plate')} required>
              <Input
                type="text"
                value={kennzeichen}
                onChange={(e) => setKennzeichen(e.target.value.toUpperCase())}
                placeholder={t('fleet.kennzeichenPlaceholder')}
                required
                disabled={loading}
              />
            </Field>

            <fieldset className="grid gap-4 rounded-surface border border-line px-4 pb-4 pt-1">
              <legend className="px-1 text-[13px] font-semibold text-fg">{t('fleet.tuevSection')}</legend>
              <Field label={t('fleet.tuevValidUntil')} hint={t('fleet.tuevValidUntilHint')}>
                <div className="flex gap-2">
                  <Input
                    type="date"
                    value={tuevGueltigBis}
                    onChange={(e) => setTuevGueltigBis(e.target.value)}
                    disabled={loading}
                  />
                  <Tooltip content={t('fleet.renewTuevTooltip')}>
                    <Button variant="secondary" onClick={handleRenewTuev} disabled={loading}>
                      <RefreshCw aria-hidden />
                      {t('fleet.plusOneYear')}
                    </Button>
                  </Tooltip>
                </div>
              </Field>
              <Field label={t('fleet.lastHu')} hint={t('fleet.lastHuHint')}>
                <Input
                  type="date"
                  value={letzteHu}
                  onChange={(e) => setLetzteHu(e.target.value)}
                  disabled={loading}
                />
              </Field>
            </fieldset>

            <fieldset className="grid gap-2">
              <legend className="mb-2 text-[13px] font-medium text-fg-muted">{t('fleet.assignDrivers')}</legend>
              {loadingDrivers ? (
                <div className="grid gap-2">
                  <Skeleton className="h-11" />
                  <Skeleton className="h-11" />
                  <Skeleton className="h-11" />
                  <span className="sr-only">{t('common.loading')}</span>
                </div>
              ) : availableDrivers.length === 0 ? (
                <p className="text-sm text-fg-subtle">{t('fleet.noDriversAvailable')}</p>
              ) : (
                <div className="max-h-64 divide-y divide-line overflow-y-auto rounded-surface border border-line">
                  {availableDrivers.map((driver) => {
                    const isSelected = selectedDriverIds.includes(driver.id);
                    const isDisabled = loading || (!isSelected && selectedDriverIds.length >= 2);
                    return (
                      // The whole row is the label, so the touch target is the row.
                      <label
                        key={driver.id}
                        className={cn(
                          'flex min-h-11 cursor-pointer items-center gap-3 px-4 py-2 text-sm text-fg transition-colors hover:bg-sunken',
                          isSelected && 'bg-brand-soft hover:bg-brand-soft',
                          isDisabled && !isSelected && 'cursor-not-allowed opacity-50 hover:bg-transparent',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => { if (!isDisabled) handleDriverToggle(driver.id); }}
                          disabled={isDisabled}
                          className="size-4 shrink-0 cursor-pointer accent-brand disabled:cursor-not-allowed"
                        />
                        <span>{driver.name}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-fg-subtle" aria-live="polite">
                {t('fleet.driversSelected', { count: selectedDriverIds.length })}
              </p>
            </fieldset>
          </form>
        </SheetBody>

        <SheetFooter>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={FORM_ID} loading={loading}>
            {loading ? null : <Save aria-hidden />}
            {loading ? t('common.saving') : t('common.save')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
