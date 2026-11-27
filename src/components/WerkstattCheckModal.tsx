import React, { useState, useEffect } from 'react';
import { Save, Wrench, Calendar } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { getWeekNumber, getWeeksOfMonth, getWeekNumberForDate, getBusinessMonth } from '../utils/weekCalculations';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import { updateChecked } from '../lib/writeOutcome';
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  Field, Input, NativeSelect, cn,
} from './ui';
import { controlFrameClass } from './ui/Input';

interface Car {
  id: string;
  kennzeichen: string;
}

interface WerkstattCheck {
  id: string;
  car_id: string;
  week_number: number;
  year: number;
  check_date: string;
  status: 'positive' | 'negative' | 'repaired';
  notes: string;
  repair_notes: string | null;
  oil_status: string | null;
  km_stand: number;
}

interface WerkstattCheckModalProps {
  check: WerkstattCheck | null;
  onClose: () => void;
  onSuccess: () => void;
}

export default function WerkstattCheckModal({
  check,
  onClose,
  onSuccess
}: WerkstattCheckModalProps) {
  const [carId, setCarId] = useState(check?.car_id || '');
  const [selectedMonth, setSelectedMonth] = useState(() =>
    check ? new Date(check.check_date) : new Date()
  );
  const [selectedWeek, setSelectedWeek] = useState(() => {
    if (check) {
      return getWeekNumberForDate(new Date(check.check_date));
    }
    return getWeekNumberForDate(new Date());
  });
  const [weeks, setWeeks] = useState<any[]>([]);
  const [checkDate, setCheckDate] = useState(
    check?.check_date || new Date().toISOString().split('T')[0]
  );
  const [status, setStatus] = useState<'positive' | 'negative' | 'repaired'>(
    check?.status || 'positive'
  );
  const [notes, setNotes] = useState(check?.notes || '');
  const [repairNotes, setRepairNotes] = useState(check?.repair_notes || '');
  const [oilStatus, setOilStatus] = useState(check?.oil_status || '');
  const [kmStand, setKmStand] = useState(check?.km_stand?.toString() || '');
  const [cars, setCars] = useState<Car[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingCars, setLoadingCars] = useState(true);
  const { user } = useAuth();
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const { showToast } = useToast();
  const { t } = useTranslation();

  useEffect(() => {
    const weeksOfMonth = getWeeksOfMonth(selectedMonth);
    setWeeks(weeksOfMonth);

    if (weeksOfMonth.length > 0 && !check) {
      const currentWeek = getWeekNumberForDate(new Date());
      if (weeksOfMonth.some(w => w.weekNumber === currentWeek)) {
        setSelectedWeek(currentWeek);
      } else {
        setSelectedWeek(weeksOfMonth[0].weekNumber);
      }
    }
  }, [selectedMonth, check]);

  useEffect(() => {
    if (companyId) loadCars();
  }, [companyId]);

  const loadCars = async () => {
    try {
      setLoadingCars(true);
      const { data, error } = await supabase
        .from('cars')
        .select('id, kennzeichen')
        .eq('company_id', companyId)
        .order('kennzeichen');

      if (error) throw error;
      setCars(data || []);
    } catch (error: any) {
      console.error('Error loading cars:', error);
      showToast('error', t('fleet.carsLoadFailed', { error: error.message }));
    } finally {
      setLoadingCars(false);
    }
  };

  const handleMonthChange = (direction: 'prev' | 'next') => {
    const newMonth = new Date(selectedMonth);
    newMonth.setMonth(selectedMonth.getMonth() + (direction === 'next' ? 1 : -1));
    setSelectedMonth(newMonth);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!carId) {
      showToast('error', t('fleet.selectCarRequired'));
      return;
    }

    if (!kmStand || kmStand.trim() === '' || parseInt(kmStand) < 0) {
      showToast('error', t('fleet.kmStandInvalid'));
      return;
    }

    if (!user) {
      showToast('error', t('fleet.mustBeSignedIn'));
      return;
    }

    try {
      setLoading(true);

      const weekData = weeks.find(w => w.weekNumber === selectedWeek);
      if (!weekData) {
        showToast('error', t('fleet.invalidWeek'));
        return;
      }

      const selectedDate = checkDate || weekData.firstDay.toISOString().split('T')[0];

      /*
        The rule being preserved — business week ownership (CLAUDE.md,
        utils/weekCalculations): a week runs Monday to Sunday and belongs to the
        month containing its Monday, and `week_number` is the 1..5 ordinal of
        that week inside its business month.

        Both columns are descriptive: since migration 20260928121500 the table's
        uniqueness rule is UNIQUE (car_id, date_trunc('week', check_date)), and
        nothing reads week_number as a key — WerkstattPage loads by check_date
        between the selected week's Monday and Sunday, OverviewPage orders by
        check_date, and no screen renders it.

        What changes here is which date they describe: the row's own
        `check_date`, not the month the navigator happens to show.
        `selectedMonth.getFullYear()` was the calendar year of the navigated
        Date, while the week dropdown beside it lists the weeks of that date's
        *business* month (getWeeksOfMonth -> getBusinessMonth), so on 01.-04.
        January a check was stored as week 5 of 2026 for a week belonging to
        December 2025. Measured on staging on 28.09.2026: 3 of the 7 stored rows
        carry a week_number that is not the ordinal of their own check_date.

        Parsed field by field rather than with `new Date(string)`: a bare
        'YYYY-MM-DD' is read as UTC midnight, which is the previous day west of
        Greenwich, and this whole calendar is local. A value the browser could
        not produce falls back to the old source rather than throwing the save.
      */
      const [datePartYear, datePartMonth, datePartDay] = selectedDate.split('-').map(Number);
      const parsedCheckDate = new Date(datePartYear, datePartMonth - 1, datePartDay);
      const weekSource = Number.isNaN(parsedCheckDate.getTime()) ? selectedMonth : parsedCheckDate;

      const checkData = {
        car_id: carId,
        week_number: getWeekNumberForDate(weekSource),
        year: getBusinessMonth(weekSource).year,
        check_date: selectedDate,
        status,
        notes: notes.trim(),
        repair_notes: status === 'repaired' && repairNotes.trim() ? repairNotes.trim() : null,
        oil_status: oilStatus.trim() || null,
        km_stand: parseInt(kmStand),
        created_by: user.id,
        company_id: companyId
      };

      if (check) {
        // A refused UPDATE changes nothing and raises nothing: read what it did.
        const outcome = await updateChecked(supabase, 'werkstatt_checks', checkData, q => q.eq('id', check.id));
        if (outcome !== 'done') {
          showToast('error', t(outcome === 'refused' ? 'common.writeRefused' : 'common.writeAlreadyGone'));
          if (outcome === 'gone') onSuccess();
          return;
        }
        showToast('success', t('fleet.werkstattCheckUpdated'));
      } else {
        const { error } = await supabase
          .from('werkstatt_checks')
          .insert(checkData);

        if (error) throw error;
        showToast('success', t('fleet.werkstattCheckCreated'));
      }

      onSuccess();
    } catch (error: any) {
      console.error('Error saving werkstatt check:', error);
      if (error.message.includes('duplicate key')) {
        showToast('error', t('fleet.werkstattCheckDuplicate'));
      } else {
        showToast('error', t('fleet.saveFailed', { error: error.message }));
      }
    } finally {
      setLoading(false);
    }
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the form's logic and is unchanged, bar the module-level
  // `inputStyle` object, which was only look and is classes now. Everything
  // below only draws.

  const FORM_ID = 'werkstatt-check-form';

  const textareaClass = cn(
    controlFrameClass,
    'h-auto min-h-0 resize-y py-2 [@media(pointer:coarse)]:h-auto',
  );

  const statusOptions = [
    { key: 'positive' as const, label: t('werkstatt.positive'), active: 'border-positive bg-positive-soft text-positive' },
    { key: 'negative' as const, label: t('werkstatt.negative'), active: 'border-critical bg-critical-soft text-critical' },
    { key: 'repaired' as const, label: t('werkstatt.repaired'), active: 'border-info bg-info-soft text-info' },
  ];

  return (
    <Dialog
      open
      onOpenChange={open => {
        // Cancel is disabled while a save runs, so Escape and the close button wait too.
        if (!open && !loading) onClose();
      }}
    >
      <DialogContent
        className="max-w-2xl"
        // A click beside the form must not throw away what was typed; the old
        // modal ignored it as well. Escape and the close button still close.
        onInteractOutside={event => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 text-xl">
            <span className="flex size-10 items-center justify-center rounded-tile bg-caution-soft text-caution">
              <Wrench aria-hidden className="size-5" />
            </span>
            {check ? t('fleet.editCheck') : t('fleet.newWerkstattCheck')}
          </DialogTitle>
          <DialogDescription className="sr-only">{t('werkstatt.subtitle')}</DialogDescription>
        </DialogHeader>

        <form id={FORM_ID} onSubmit={handleSubmit} className="grid gap-5">
          <Field label={t('fleet.vehicle')} required>
            <NativeSelect
              value={carId}
              onChange={(e) => setCarId(e.target.value)}
              required
              disabled={loading || loadingCars || !!check}
            >
              <option value="">{t('fleet.selectVehicle')}</option>
              {cars.map((car) => (
                <option key={car.id} value={car.id}>
                  {car.kennzeichen}
                </option>
              ))}
            </NativeSelect>
          </Field>

          <Field label={t('fleet.monthAndWeek')} required>
            <div className="flex flex-wrap items-center gap-3 rounded-control border border-line bg-sunken p-3">
              {/* One group, so a phone never leaves „→“ on a line of its own. */}
              <div className="flex items-center gap-2">
                <Calendar aria-hidden className="size-5 text-fg-muted" />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="[@media(pointer:coarse)]:min-w-10"
                  onClick={() => handleMonthChange('prev')}
                  disabled={loading}
                >
                  ←
                </Button>
                <div className="min-w-[120px] whitespace-nowrap text-center font-semibold text-fg sm:min-w-[140px]">
                  {selectedMonth.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })}
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="[@media(pointer:coarse)]:min-w-10"
                  onClick={() => handleMonthChange('next')}
                  disabled={loading}
                >
                  →
                </Button>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setSelectedMonth(new Date())}
                disabled={loading}
              >
                {t('common.today')}
              </Button>
              <div className="flex-1" />
              <NativeSelect
                containerClassName="w-auto"
                className="h-9"
                value={selectedWeek}
                onChange={(e) => setSelectedWeek(Number(e.target.value))}
                disabled={loading}
              >
                {weeks.map((week) => (
                  <option key={week.weekNumber} value={week.weekNumber}>
                    {week.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </Field>

          <Field label={t('fleet.checkDateOptional')} hint={t('fleet.checkDateHint')}>
            <Input
              type="date"
              value={checkDate}
              onChange={(e) => setCheckDate(e.target.value)}
              disabled={loading}
            />
          </Field>

          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-[13px] font-[550] text-fg-muted">
              {t('common.status')}<span aria-hidden className="ml-0.5 text-critical">*</span>
            </legend>
            <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-3">
              {statusOptions.map(option => (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={status === option.key}
                  onClick={() => setStatus(option.key)}
                  disabled={loading}
                  className={cn(
                    'rounded-control border-2 px-4 py-3 text-sm transition-colors [@media(pointer:coarse)]:min-h-11',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-50',
                    status === option.key ? cn('font-medium', option.active) : 'border-line font-normal text-fg-muted hover:bg-sunken',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>

          {/* The example values stay German: whatever is typed here is stored
              verbatim and printed into the German Werkstatt Excel export. */}
          <Field label={t('werkstatt.oilStatus')}>
            <Input
              type="text"
              value={oilStatus}
              onChange={(e) => setOilStatus(e.target.value)}
              placeholder={t('fleet.oilStatusPlaceholder')}
              disabled={loading}
            />
          </Field>

          <Field label={t('werkstatt.odometer')} required>
            <Input
              type="number"
              value={kmStand}
              onChange={(e) => setKmStand(e.target.value)}
              placeholder={t('fleet.odometerPlaceholder')}
              min="0"
              required
              disabled={loading}
            />
          </Field>

          <Field label={t('fleet.checkNotes')} required id="werkstatt-check-notes">
            <textarea
              id="werkstatt-check-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              className={textareaClass}
              placeholder={t('fleet.checkNotesPlaceholder')}
              required
              disabled={loading}
            />
          </Field>

          {status === 'repaired' && (
            <Field label={t('fleet.repairNotes')} id="werkstatt-repair-notes">
              <textarea
                id="werkstatt-repair-notes"
                value={repairNotes}
                onChange={(e) => setRepairNotes(e.target.value)}
                rows={3}
                className={textareaClass}
                placeholder={t('fleet.repairNotesPlaceholder')}
                disabled={loading}
              />
            </Field>
          )}
        </form>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose} disabled={loading}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={FORM_ID} loading={loading}>
            {loading ? null : <Save aria-hidden />}
            {loading ? t('common.saving') : t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
