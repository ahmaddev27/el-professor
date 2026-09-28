import React, { useState, useEffect } from 'react';
import { X, Save, Wrench, Calendar } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { getWeekNumber, getWeeksOfMonth, getWeekNumberForDate, getBusinessMonth } from '../utils/weekCalculations';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';

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

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: '0.5rem',
  color: 'var(--text-primary)',
  fontSize: '0.875rem',
  padding: '0.5rem 0.75rem',
  outline: 'none',
  width: '100%',
};

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
        const { error } = await supabase
          .from('werkstatt_checks')
          .update(checkData)
          .eq('id', check.id);

        if (error) throw error;
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

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div style={{ background: 'var(--bg-surface)', borderRadius: '0.5rem', boxShadow: 'var(--shadow-lg)' }} className="max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0 }} className="px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div style={{ background: 'var(--warning-subtle)', borderRadius: '0.5rem', padding: '0.5rem' }}>
              <Wrench style={{ color: 'var(--warning)' }} className="w-6 h-6" />
            </div>
            <h2 style={{ color: 'var(--text-primary)' }} className="text-xl font-semibold">
              {check ? t('fleet.editCheck') : t('fleet.newWerkstattCheck')}
            </h2>
          </div>
          <button
            onClick={onClose}
            style={{ color: 'var(--text-tertiary)' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-tertiary)')}
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          <div>
            <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-2">
              {t('fleet.vehicle')} *
            </label>
            <select
              value={carId}
              onChange={(e) => setCarId(e.target.value)}
              style={{ ...inputStyle, appearance: 'none' }}
              required
              disabled={loading || loadingCars || !!check}
            >
              <option value="">{t('fleet.selectVehicle')}</option>
              {cars.map((car) => (
                <option key={car.id} value={car.id}>
                  {car.kennzeichen}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-2">
              {t('fleet.monthAndWeek')} *
            </label>
            <div style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: '0.5rem', padding: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <Calendar style={{ color: 'var(--text-secondary)' }} className="w-5 h-5" />
              <button
                type="button"
                onClick={() => handleMonthChange('prev')}
                style={{ border: '1px solid var(--border)', borderRadius: '0.5rem', padding: '0.25rem 0.75rem', background: 'var(--bg-surface)', color: 'var(--text-primary)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-surface)')}
                disabled={loading}
              >
                ←
              </button>
              <div className="text-center min-w-[140px]">
                <div style={{ color: 'var(--text-primary)' }} className="font-semibold">
                  {selectedMonth.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })}
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleMonthChange('next')}
                style={{ border: '1px solid var(--border)', borderRadius: '0.5rem', padding: '0.25rem 0.75rem', background: 'var(--bg-surface)', color: 'var(--text-primary)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-surface)')}
                disabled={loading}
              >
                →
              </button>
              <button
                type="button"
                onClick={() => setSelectedMonth(new Date())}
                style={{ background: 'var(--bg-muted)', color: 'var(--text-secondary)', borderRadius: '0.5rem', padding: '0.25rem 0.75rem', fontSize: '0.875rem', border: '1px solid var(--border)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--border)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
                disabled={loading}
              >
                {t('common.today')}
              </button>
              <div className="flex-1" />
              <select
                value={selectedWeek}
                onChange={(e) => setSelectedWeek(Number(e.target.value))}
                style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: '0.5rem', color: 'var(--text-primary)', padding: '0.25rem 0.75rem', outline: 'none', appearance: 'none' }}
                disabled={loading}
              >
                {weeks.map((week) => (
                  <option key={week.weekNumber} value={week.weekNumber}>
                    {week.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-2">
              {t('fleet.checkDateOptional')}
            </label>
            <input
              type="date"
              value={checkDate}
              onChange={(e) => setCheckDate(e.target.value)}
              style={inputStyle}
              disabled={loading}
            />
            <p style={{ color: 'var(--text-tertiary)' }} className="text-xs mt-1">
              {t('fleet.checkDateHint')}
            </p>
          </div>

          <div>
            <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-2">
              {t('common.status')} *
            </label>
            <div className="grid grid-cols-3 gap-3">
              <button
                type="button"
                onClick={() => setStatus('positive')}
                style={{
                  padding: '0.75rem 1rem',
                  borderRadius: '0.5rem',
                  border: status === 'positive' ? '2px solid var(--success)' : '2px solid var(--border)',
                  background: status === 'positive' ? 'var(--success-subtle)' : 'transparent',
                  color: status === 'positive' ? 'var(--success)' : 'var(--text-secondary)',
                  fontWeight: status === 'positive' ? 500 : 400,
                  cursor: 'pointer',
                }}
                disabled={loading}
              >
                {t('werkstatt.positive')}
              </button>
              <button
                type="button"
                onClick={() => setStatus('negative')}
                style={{
                  padding: '0.75rem 1rem',
                  borderRadius: '0.5rem',
                  border: status === 'negative' ? '2px solid var(--danger)' : '2px solid var(--border)',
                  background: status === 'negative' ? 'var(--danger-subtle)' : 'transparent',
                  color: status === 'negative' ? 'var(--danger)' : 'var(--text-secondary)',
                  fontWeight: status === 'negative' ? 500 : 400,
                  cursor: 'pointer',
                }}
                disabled={loading}
              >
                {t('werkstatt.negative')}
              </button>
              <button
                type="button"
                onClick={() => setStatus('repaired')}
                style={{
                  padding: '0.75rem 1rem',
                  borderRadius: '0.5rem',
                  border: status === 'repaired' ? '2px solid var(--accent)' : '2px solid var(--border)',
                  background: status === 'repaired' ? 'var(--accent-subtle)' : 'transparent',
                  color: status === 'repaired' ? 'var(--accent)' : 'var(--text-secondary)',
                  fontWeight: status === 'repaired' ? 500 : 400,
                  cursor: 'pointer',
                }}
                disabled={loading}
              >
                {t('werkstatt.repaired')}
              </button>
            </div>
          </div>

          <div>
            <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-2">
              {t('werkstatt.oilStatus')}
            </label>
            {/* The example values stay German: whatever is typed here is stored
                verbatim and printed into the German Werkstatt Excel export. */}
            <input
              type="text"
              value={oilStatus}
              onChange={(e) => setOilStatus(e.target.value)}
              style={inputStyle}
              placeholder={t('fleet.oilStatusPlaceholder')}
              disabled={loading}
            />
          </div>

          <div>
            <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-2">
              {t('werkstatt.odometer')} *
            </label>
            <input
              type="number"
              value={kmStand}
              onChange={(e) => setKmStand(e.target.value)}
              style={inputStyle}
              placeholder={t('fleet.odometerPlaceholder')}
              min="0"
              required
              disabled={loading}
            />
          </div>

          <div>
            <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-2">
              {t('fleet.checkNotes')} *
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              style={{ ...inputStyle, resize: 'vertical' }}
              placeholder={t('fleet.checkNotesPlaceholder')}
              required
              disabled={loading}
            />
          </div>

          {status === 'repaired' && (
            <div>
              <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-2">
                {t('fleet.repairNotes')}
              </label>
              <textarea
                value={repairNotes}
                onChange={(e) => setRepairNotes(e.target.value)}
                rows={3}
                style={{ ...inputStyle, resize: 'vertical' }}
                placeholder={t('fleet.repairNotesPlaceholder')}
                disabled={loading}
              />
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1rem' }} className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              style={{ flex: 1, padding: '0.5rem 1rem', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '0.5rem', background: 'transparent' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              disabled={loading}
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              style={{ flex: 1, padding: '0.5rem 1rem', background: loading ? 'var(--bg-muted)' : 'var(--warning-solid)', color: loading ? 'var(--text-tertiary)' : '#fff', borderRadius: '0.5rem', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
              onMouseEnter={e => { if (!loading) e.currentTarget.style.opacity = '0.9'; }}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
              disabled={loading}
            >
              <Save className="w-5 h-5" />
              {loading ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
