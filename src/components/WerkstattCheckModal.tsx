import React, { useState, useEffect } from 'react';
import { X, Save, Wrench, Calendar } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { getWeekNumber, getWeeksOfMonth, getWeekNumberForDate } from '../utils/weekCalculations';

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
  const { user, companyId } = useAuth();
  const { showToast } = useToast();

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
      showToast('error', 'Fehler beim Laden der Fahrzeuge: ' + error.message);
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
      showToast('error', 'Bitte wählen Sie ein Fahrzeug aus');
      return;
    }

    if (!kmStand || kmStand.trim() === '' || parseInt(kmStand) < 0) {
      showToast('error', 'Bitte geben Sie einen gültigen KM-Stand ein');
      return;
    }

    if (!user) {
      showToast('error', 'Sie müssen angemeldet sein');
      return;
    }

    try {
      setLoading(true);

      const weekData = weeks.find(w => w.weekNumber === selectedWeek);
      if (!weekData) {
        showToast('error', 'Ungültige Woche ausgewählt');
        return;
      }

      const selectedDate = checkDate || weekData.firstDay.toISOString().split('T')[0];

      const checkData = {
        car_id: carId,
        week_number: selectedWeek,
        year: selectedMonth.getFullYear(),
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
        showToast('success', 'Werkstatt-Check erfolgreich aktualisiert');
      } else {
        const { error } = await supabase
          .from('werkstatt_checks')
          .insert(checkData);

        if (error) throw error;
        showToast('success', 'Werkstatt-Check erfolgreich erstellt');
      }

      onSuccess();
    } catch (error: any) {
      console.error('Error saving werkstatt check:', error);
      if (error.message.includes('duplicate key')) {
        showToast('error', 'Für dieses Fahrzeug wurde bereits ein Check in dieser Woche erstellt');
      } else {
        showToast('error', 'Fehler beim Speichern: ' + error.message);
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
              {check ? 'Check bearbeiten' : 'Neuer Werkstatt-Check'}
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
              Fahrzeug *
            </label>
            <select
              value={carId}
              onChange={(e) => setCarId(e.target.value)}
              style={{ ...inputStyle, appearance: 'none' }}
              required
              disabled={loading || loadingCars || !!check}
            >
              <option value="">Fahrzeug auswählen</option>
              {cars.map((car) => (
                <option key={car.id} value={car.id}>
                  {car.kennzeichen}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-2">
              Monat und Woche *
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
                Heute
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
              Check-Datum (optional)
            </label>
            <input
              type="date"
              value={checkDate}
              onChange={(e) => setCheckDate(e.target.value)}
              style={inputStyle}
              disabled={loading}
            />
            <p style={{ color: 'var(--text-tertiary)' }} className="text-xs mt-1">
              Falls leer, wird der erste Tag der ausgewählten Woche verwendet
            </p>
          </div>

          <div>
            <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-2">
              Status *
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
                Positiv
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
                Negativ
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
                Repariert
              </button>
            </div>
          </div>

          <div>
            <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-2">
              Öl-Status
            </label>
            <input
              type="text"
              value={oilStatus}
              onChange={(e) => setOilStatus(e.target.value)}
              style={inputStyle}
              placeholder="z.B. OK, Niedrig, Gewechselt"
              disabled={loading}
            />
          </div>

          <div>
            <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-2">
              KM-Stand *
            </label>
            <input
              type="number"
              value={kmStand}
              onChange={(e) => setKmStand(e.target.value)}
              style={inputStyle}
              placeholder="Aktueller Kilometerstand"
              min="0"
              required
              disabled={loading}
            />
          </div>

          <div>
            <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-2">
              Check-Notizen *
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              style={{ ...inputStyle, resize: 'vertical' }}
              placeholder="Allgemeine Notizen zum Check..."
              required
              disabled={loading}
            />
          </div>

          {status === 'repaired' && (
            <div>
              <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-2">
                Reparatur-Notizen
              </label>
              <textarea
                value={repairNotes}
                onChange={(e) => setRepairNotes(e.target.value)}
                rows={3}
                style={{ ...inputStyle, resize: 'vertical' }}
                placeholder="Details zur durchgeführten Reparatur..."
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
              Abbrechen
            </button>
            <button
              type="submit"
              style={{ flex: 1, padding: '0.5rem 1rem', background: loading ? 'var(--bg-muted)' : 'var(--warning)', color: loading ? 'var(--text-tertiary)' : '#fff', borderRadius: '0.5rem', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
              onMouseEnter={e => { if (!loading) e.currentTarget.style.opacity = '0.9'; }}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
              disabled={loading}
            >
              <Save className="w-5 h-5" />
              {loading ? 'Speichern...' : 'Speichern'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
