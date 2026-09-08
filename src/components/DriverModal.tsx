import React, { useState, useEffect } from 'react';
import { X, Save, User, ChevronDown, ChevronUp } from 'lucide-react';
import { Driver } from '../types/receipt';

type Gender = 'male' | 'female' | '';

export interface DriverPlanningFields {
  employment_type: 'employee' | 'company_owner';
  driver_usage_type: 'regular' | 'coverage_only';
  target_monthly_hours: string;
  max_monthly_hours: string;
  planning_target_salary: string;
  planning_min_salary: string;
  planning_max_salary: string;
  planning_hourly_rate: string;
  planning_priority: string;
  planning_enabled: boolean;
  can_cover_other_drivers: boolean;
  work_window_start: string;
  work_window_end: string;
  allowed_weekdays: number[];
  allow_outside_shift_exceptions: boolean;
  is_full_day_available: boolean;
}

// Weekday encoding: 1=Mon, 2=Tue, ..., 7=Sun (ISO).
export const WEEKDAY_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: 'Mo' },
  { value: 2, label: 'Di' },
  { value: 3, label: 'Mi' },
  { value: 4, label: 'Do' },
  { value: 5, label: 'Fr' },
  { value: 6, label: 'Sa' },
  { value: 7, label: 'So' },
];

interface DriverModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (
    name: string,
    salaryRatio: number,
    personalnummer: string,
    gender: 'male' | 'female' | null,
    planning: DriverPlanningFields,
  ) => void;
  driver?: Driver;
  title: string;
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

const DEFAULT_PLANNING: DriverPlanningFields = {
  employment_type: 'employee',
  driver_usage_type: 'regular',
  target_monthly_hours: '',
  max_monthly_hours: '',
  planning_target_salary: '',
  planning_min_salary: '',
  planning_max_salary: '',
  planning_hourly_rate: '',
  planning_priority: '100',
  planning_enabled: true,
  can_cover_other_drivers: true,
  work_window_start: '',
  work_window_end: '',
  allowed_weekdays: [1, 2, 3, 4, 5],
  allow_outside_shift_exceptions: false,
  is_full_day_available: false,
};

const DriverModal: React.FC<DriverModalProps> = ({
  isOpen,
  onClose,
  onSave,
  driver,
  title
}) => {
  const [name, setName] = useState('');
  const [salaryRatio, setSalaryRatio] = useState('50');
  const [personalnummer, setPersonalnummer] = useState('');
  const [gender, setGender] = useState<Gender>('');
  const [planning, setPlanning] = useState<DriverPlanningFields>(DEFAULT_PLANNING);
  const [showPlanning, setShowPlanning] = useState(false);
  const [salaryRangeError, setSalaryRangeError] = useState('');

  useEffect(() => {
    if (driver) {
      setName(driver.name);
      setSalaryRatio(((driver.salary_ratio ?? 0.5) * 100).toString());
      setPersonalnummer(driver.personalnummer || '');
      setGender((driver.gender as Gender) || '');
      setPlanning({
        employment_type: driver.employment_type ?? 'employee',
        driver_usage_type: driver.driver_usage_type ?? 'regular',
        target_monthly_hours: driver.target_monthly_hours != null ? String(driver.target_monthly_hours) : '',
        max_monthly_hours: driver.max_monthly_hours != null ? String(driver.max_monthly_hours) : '',
        planning_target_salary: driver.planning_target_salary != null ? String(driver.planning_target_salary) : '',
        planning_min_salary: driver.planning_min_salary != null ? String(driver.planning_min_salary)
          : driver.planning_target_salary != null ? String(driver.planning_target_salary) : '',
        planning_max_salary: driver.planning_max_salary != null ? String(driver.planning_max_salary)
          : driver.planning_target_salary != null ? String(driver.planning_target_salary) : '',
        planning_hourly_rate: driver.planning_hourly_rate != null ? String(driver.planning_hourly_rate) : '',
        planning_priority: String(driver.planning_priority ?? 100),
        planning_enabled: driver.planning_enabled ?? true,
        can_cover_other_drivers: driver.can_cover_other_drivers ?? true,
        work_window_start: driver.work_window_start ?? '',
        work_window_end: driver.work_window_end ?? '',
        allowed_weekdays: Array.isArray(driver.allowed_weekdays) && driver.allowed_weekdays.length > 0
          ? driver.allowed_weekdays
          : [1, 2, 3, 4, 5],
        allow_outside_shift_exceptions: driver.allow_outside_shift_exceptions ?? false,
        is_full_day_available: driver.is_full_day_available ?? false,
      });
    } else {
      setName('');
      setSalaryRatio('50');
      setPersonalnummer('');
      setGender('');
      setPlanning(DEFAULT_PLANNING);
    }
    setShowPlanning(false);
  }, [driver, isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      const minSal = planning.planning_min_salary !== '' ? parseFloat(planning.planning_min_salary) : null;
      const maxSal = planning.planning_max_salary !== '' ? parseFloat(planning.planning_max_salary) : null;
      if (minSal != null && maxSal != null && maxSal < minSal) {
        setSalaryRangeError('Maximalgehalt darf nicht kleiner als Mindestgehalt sein.');
        return;
      }
      setSalaryRangeError('');
      const ratio = parseFloat(salaryRatio) / 100;
      const genderValue: 'male' | 'female' | null = gender === '' ? null : gender;
      onSave(name.trim(), ratio, personalnummer.trim(), genderValue, planning);
      setName('');
      setSalaryRatio('50');
      setPersonalnummer('');
      setGender('');
      setPlanning(DEFAULT_PLANNING);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div style={{ background: 'var(--bg-surface)', borderRadius: '0.5rem', boxShadow: 'var(--shadow-lg)' }}
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 sticky top-0"
          style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)' }}>
          <h2 style={{ color: 'var(--text-primary)' }} className="text-xl font-semibold flex items-center space-x-2">
            <User size={20} />
            <span>{title}</span>
          </h2>
          <button
            onClick={onClose}
            style={{ color: 'var(--text-tertiary)' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-tertiary)')}
          >
            <X size={24} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Core fields */}
          <div>
            <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-1">
              Fahrername *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={inputStyle}
              placeholder="Name des Fahrers eingeben"
              required
            />
          </div>

          <div>
            <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-1">
              Personalnummer *
            </label>
            <input
              type="text"
              value={personalnummer}
              onChange={(e) => setPersonalnummer(e.target.value)}
              style={inputStyle}
              placeholder="z.B. 11, P-042, ..."
              required
            />
            <p style={{ color: 'var(--text-tertiary)' }} className="text-xs mt-1">
              Eindeutige Personalnummer des Fahrers (wird im Stundennachweis verwendet)
            </p>
          </div>

          <div>
            <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-1">
              Anrede / Geschlecht
            </label>
            <select
              value={gender}
              onChange={(e) => setGender(e.target.value as Gender)}
              style={inputStyle}
            >
              <option value="">— nicht angegeben —</option>
              <option value="male">männlich (Herr)</option>
              <option value="female">weiblich (Frau)</option>
            </select>
            <p style={{ color: 'var(--text-tertiary)' }} className="text-xs mt-1">
              Wird für die Anrede in der Trinkgeld Quittung verwendet (Herr / Frau).
            </p>
          </div>

          <div>
            <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-1">
              Umsatzanteil (%)
            </label>
            <div className="relative">
              <input
                type="number"
                value={salaryRatio}
                onChange={(e) => setSalaryRatio(e.target.value)}
                min="0"
                max="100"
                step="0.1"
                style={{ ...inputStyle, padding: '0.5rem 2rem 0.5rem 0.75rem' }}
                placeholder="50"
                required
              />
              <span style={{ color: 'var(--text-tertiary)' }} className="absolute right-3 top-1/2 transform -translate-y-1/2">%</span>
            </div>
            <p style={{ color: 'var(--text-tertiary)' }} className="text-xs mt-1">
              Anteil des Umsatzes, den der Fahrer erhält (0-100%). Standard: 50%
            </p>
          </div>

          {/* Planning section (collapsible) */}
          <div style={{ border: '1px solid var(--border)', borderRadius: '0.5rem', overflow: 'hidden' }}>
            <button
              type="button"
              onClick={() => setShowPlanning(v => !v)}
              className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-left"
              style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}
            >
              <span>Planungseinstellungen</span>
              {showPlanning ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>

            {showPlanning && (
              <div className="p-4 space-y-4">
                <div>
                  <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-1">
                    Fahrerrolle
                  </label>
                  <select
                    value={planning.employment_type}
                    onChange={e => setPlanning(p => ({ ...p, employment_type: e.target.value as 'employee' | 'company_owner' }))}
                    style={inputStyle}
                  >
                    <option value="employee">Angestellter Fahrer</option>
                    <option value="company_owner">Inhaber / Selbstständig</option>
                  </select>
                  <p style={{ color: 'var(--text-tertiary)' }} className="text-xs mt-1">
                    Inhaber / Selbstständige sind von täglichen und monatlichen Stundenlimits ausgenommen und werden als Fallback nach regulären Fahrern eingesetzt.
                  </p>
                </div>

                <div>
                  <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-1">
                    Nutzung im Plan
                  </label>
                  <select
                    value={planning.driver_usage_type}
                    onChange={e => setPlanning(p => ({ ...p, driver_usage_type: e.target.value as 'regular' | 'coverage_only' }))}
                    style={inputStyle}
                  >
                    <option value="regular">Regulärer Fahrer</option>
                    <option value="coverage_only">Planungs-/Deckungsfahrer</option>
                  </select>
                  <p style={{ color: 'var(--text-tertiary)' }} className="text-xs mt-1">
                    Deckungsfahrer erhalten Fahrten nur im Planungsvorschlag, wenn reguläre Fahrer überlastet sind.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-1">
                      Zielstunden / Monat
                    </label>
                    <input
                      type="number"
                      value={planning.target_monthly_hours}
                      onChange={e => setPlanning(p => ({ ...p, target_monthly_hours: e.target.value }))}
                      style={inputStyle}
                      placeholder="z.B. 160"
                      min="0"
                      step="0.5"
                    />
                  </div>
                  <div>
                    <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-1">
                      Maximale Stunden / Monat
                    </label>
                    <input
                      type="number"
                      value={planning.max_monthly_hours}
                      onChange={e => setPlanning(p => ({ ...p, max_monthly_hours: e.target.value }))}
                      style={inputStyle}
                      placeholder="z.B. 180"
                      min="0"
                      step="0.5"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-1">
                      Mindestgehalt (€)
                    </label>
                    <input
                      type="number"
                      value={planning.planning_min_salary}
                      onChange={e => { setPlanning(p => ({ ...p, planning_min_salary: e.target.value })); setSalaryRangeError(''); }}
                      style={inputStyle}
                      placeholder="z.B. 1800"
                      min="0"
                      step="0.01"
                    />
                  </div>
                  <div>
                    <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-1">
                      Maximalgehalt (€)
                    </label>
                    <input
                      type="number"
                      value={planning.planning_max_salary}
                      onChange={e => { setPlanning(p => ({ ...p, planning_max_salary: e.target.value })); setSalaryRangeError(''); }}
                      style={inputStyle}
                      placeholder="z.B. 2200"
                      min="0"
                      step="0.01"
                    />
                  </div>
                  {salaryRangeError && (
                    <div className="col-span-2 text-xs" style={{ color: '#b91c1c' }}>{salaryRangeError}</div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-1">
                      Stundensatz (€)
                    </label>
                    <input
                      type="number"
                      value={planning.planning_hourly_rate}
                      onChange={e => setPlanning(p => ({ ...p, planning_hourly_rate: e.target.value }))}
                      style={inputStyle}
                      placeholder="z.B. 13.50"
                      min="0"
                      step="0.01"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 items-center">
                  <div>
                    <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-1">
                      Planungspriorität
                    </label>
                    <input
                      type="number"
                      value={planning.planning_priority}
                      onChange={e => setPlanning(p => ({ ...p, planning_priority: e.target.value }))}
                      style={inputStyle}
                      placeholder="100"
                      min="1"
                      max="999"
                    />
                    <p style={{ color: 'var(--text-tertiary)' }} className="text-xs mt-1">
                      Niedrigere Zahl = höhere Priorität
                    </p>
                  </div>
                  <div>
                    <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-2">
                      Für Planung aktiv
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={planning.planning_enabled}
                        onChange={e => setPlanning(p => ({ ...p, planning_enabled: e.target.checked }))}
                        className="w-4 h-4"
                      />
                      <span style={{ color: 'var(--text-secondary)' }} className="text-sm">
                        {planning.planning_enabled ? 'Aktiv' : 'Inaktiv'}
                      </span>
                    </label>
                  </div>
                </div>

                <div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={planning.can_cover_other_drivers}
                      onChange={e => setPlanning(p => ({ ...p, can_cover_other_drivers: e.target.checked }))}
                      className="w-4 h-4"
                    />
                    <span style={{ color: 'var(--text-secondary)' }} className="text-sm font-medium">
                      Kann andere Fahrer decken
                    </span>
                  </label>
                  <p style={{ color: 'var(--text-tertiary)' }} className="text-xs mt-1 ml-6">
                    Wenn aktiv, kann dieser Fahrer Schichten anderer Fahrer übernehmen, die ihr Limit überschreiten.
                  </p>
                </div>

                <div className="pt-3 mt-3" style={{ borderTop: '1px solid var(--border)' }}>
                  <p className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                    Arbeitszeitfenster / Dienstzeit
                  </p>
                  <p className="text-xs mb-3" style={{ color: 'var(--text-tertiary)' }}>
                    Festes Zeitfenster, in dem der Fahrer normalerweise Fahrten erhält. Außerhalb gilt es als Ausnahme.
                    Wenn Ende vor Anfang liegt, gilt das Fenster über Mitternacht (z. B. 22:00 bis 06:00).
                  </p>
                  <div className="mb-3">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={planning.is_full_day_available}
                        onChange={e => setPlanning(p => ({ ...p, is_full_day_available: e.target.checked }))}
                        className="w-4 h-4"
                      />
                      <span style={{ color: 'var(--text-secondary)' }} className="text-sm font-medium">
                        Ganztägig verfügbar (24 Stunden)
                      </span>
                    </label>
                    <p style={{ color: 'var(--text-tertiary)' }} className="text-xs mt-1 ml-6">
                      Fahrer ist an erlaubten Wochentagen jederzeit einsetzbar. Tägliche/monatliche Limits gelten weiterhin.
                    </p>
                  </div>
                  {planning.is_full_day_available ? (
                    <div
                      className="px-3 py-2 rounded-lg text-sm font-medium"
                      style={{ background: 'var(--bg-subtle)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                    >
                      Arbeitszeit: Ganztägig
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-1">
                          Arbeitsbeginn
                        </label>
                        <input
                          type="time"
                          value={planning.work_window_start}
                          onChange={e => setPlanning(p => ({ ...p, work_window_start: e.target.value }))}
                          style={inputStyle}
                        />
                      </div>
                      <div>
                        <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-1">
                          Arbeitsende
                        </label>
                        <input
                          type="time"
                          value={planning.work_window_end}
                          onChange={e => setPlanning(p => ({ ...p, work_window_end: e.target.value }))}
                          style={inputStyle}
                        />
                      </div>
                    </div>
                  )}
                  <div className="mt-3">
                    <label style={{ color: 'var(--text-secondary)' }} className="block text-sm font-medium mb-2">
                      Gültig an Wochentagen
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {WEEKDAY_OPTIONS.map(wd => {
                        const active = planning.allowed_weekdays.includes(wd.value);
                        return (
                          <button
                            key={wd.value}
                            type="button"
                            onClick={() => setPlanning(p => ({
                              ...p,
                              allowed_weekdays: active
                                ? p.allowed_weekdays.filter(d => d !== wd.value)
                                : [...p.allowed_weekdays, wd.value].sort((a, b) => a - b),
                            }))}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                            style={{
                              background: active ? 'var(--accent)' : 'var(--bg-subtle)',
                              color: active ? 'white' : 'var(--text-secondary)',
                              border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                            }}
                          >
                            {wd.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="mt-3">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={planning.allow_outside_shift_exceptions}
                        onChange={e => setPlanning(p => ({ ...p, allow_outside_shift_exceptions: e.target.checked }))}
                        className="w-4 h-4"
                      />
                      <span style={{ color: 'var(--text-secondary)' }} className="text-sm font-medium">
                        Ausnahmen außerhalb der Dienstzeit erlauben
                      </span>
                    </label>
                    <p style={{ color: 'var(--text-tertiary)' }} className="text-xs mt-1 ml-6">
                      Wenn aktiv, kann der Planer Ausnahmen vorschlagen, die explizit akzeptiert werden müssen.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end space-x-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              style={{ color: 'var(--text-secondary)', background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: '0.5rem', padding: '0.5rem 1rem' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
            >
              Abbrechen
            </button>
            <button
              type="submit"
              style={{ background: 'var(--accent)', color: 'var(--accent-text)', borderRadius: '0.5rem', padding: '0.5rem 1rem', border: 'none' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
              className="flex items-center space-x-2"
            >
              <Save size={16} />
              <span>Speichern</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default DriverModal;
