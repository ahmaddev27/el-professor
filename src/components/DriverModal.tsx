import React, { useState, useEffect } from 'react';
import { ChevronDown, Save, User } from 'lucide-react';
import { Driver } from '../types/receipt';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import {
  Button,
  cn,
  Field,
  Input,
  NativeSelect,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from './ui';

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
// `label` holds a TranslationKey: this list is module-level and t() is a hook
// value. Every consumer resolves it. These are chip labels on screen, not
// document text.
export const WEEKDAY_OPTIONS: Array<{ value: number; label: TranslationKey }> = [
  { value: 1, label: 'fleet.weekday.mon' },
  { value: 2, label: 'fleet.weekday.tue' },
  { value: 3, label: 'fleet.weekday.wed' },
  { value: 4, label: 'fleet.weekday.thu' },
  { value: 5, label: 'fleet.weekday.fri' },
  { value: 6, label: 'fleet.weekday.sat' },
  { value: 7, label: 'fleet.weekday.sun' },
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
  const { t } = useTranslation();

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
        setSalaryRangeError(t('fleet.salaryRangeInvalid'));
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

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the form's logic and is unchanged, less the module-level
  // inline input style object, which only drew. The values these fields bind —
  // salary_ratio as the percent the driver keeps, the planning fields as text
  // the hook parses — and every handler below are the old ones, verbatim.

  const formId = 'driver-form';

  /** A checkbox row: the whole row is the label, so the touch target is the row. */
  const checkboxClass = 'size-4 shrink-0 cursor-pointer accent-brand';

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
          <SheetTitle className="flex items-center gap-2">
            <User aria-hidden className="size-5 text-fg-subtle" />
            {title}
          </SheetTitle>
          <SheetDescription>{t('fleet.driverFormDescription')}</SheetDescription>
        </SheetHeader>

        <SheetBody>
          <form id={formId} onSubmit={handleSubmit} className="grid gap-5">
            <Field label={t('fleet.driverName')} required>
              <Input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('fleet.driverNamePlaceholder')}
                required
              />
            </Field>

            <Field label={t('fleet.personalnummer')} hint={t('fleet.personalnummerHint')} required>
              <Input
                type="text"
                value={personalnummer}
                onChange={(e) => setPersonalnummer(e.target.value)}
                placeholder={t('fleet.personalnummerPlaceholder')}
                required
              />
            </Field>

            <Field label={t('fleet.salutationGender')} hint={t('fleet.genderHint')}>
              <NativeSelect
                value={gender}
                onChange={(e) => setGender(e.target.value as Gender)}
              >
                <option value="">{t('fleet.notSpecified')}</option>
                <option value="male">{t('fleet.male')}</option>
                <option value="female">{t('fleet.female')}</option>
              </NativeSelect>
            </Field>

            <Field label={t('fleet.revenueShare')} hint={t('fleet.revenueShareHint')} required>
              <div className="relative">
                <Input
                  type="number"
                  value={salaryRatio}
                  onChange={(e) => setSalaryRatio(e.target.value)}
                  min="0"
                  max="100"
                  step="0.1"
                  className="pr-8"
                  placeholder="50"
                  required
                />
                <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-fg-subtle">%</span>
              </div>
            </Field>

            {/* Planning section (collapsible) */}
            <div className="overflow-hidden rounded-surface border border-line">
              <button
                type="button"
                onClick={() => setShowPlanning(v => !v)}
                aria-expanded={showPlanning}
                aria-controls="driver-planning-fields"
                className={cn(
                  'flex min-h-11 w-full items-center justify-between gap-3 bg-sunken px-4 py-3 text-left text-sm font-semibold text-fg transition-colors hover:bg-sunken/70',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus',
                )}
              >
                <span>{t('fleet.planningSettings')}</span>
                <ChevronDown aria-hidden className={cn('size-4 shrink-0 text-fg-subtle transition-transform', showPlanning && 'rotate-180')} />
              </button>

              {showPlanning && (
                <div id="driver-planning-fields" className="grid gap-5 p-4">
                  <Field label={t('fleet.driverRole')} hint={t('fleet.driverRoleHint')}>
                    <NativeSelect
                      value={planning.employment_type}
                      onChange={e => setPlanning(p => ({ ...p, employment_type: e.target.value as 'employee' | 'company_owner' }))}
                    >
                      <option value="employee">{t('fleet.employee')}</option>
                      <option value="company_owner">{t('fleet.companyOwner')}</option>
                    </NativeSelect>
                  </Field>

                  <Field label={t('fleet.planUsage')} hint={t('fleet.planUsageHint')}>
                    <NativeSelect
                      value={planning.driver_usage_type}
                      onChange={e => setPlanning(p => ({ ...p, driver_usage_type: e.target.value as 'regular' | 'coverage_only' }))}
                    >
                      <option value="regular">{t('fleet.regularDriver')}</option>
                      <option value="coverage_only">{t('fleet.coverageDriver')}</option>
                    </NativeSelect>
                  </Field>

                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t('fleet.targetHoursMonth')}>
                      <Input
                        type="number"
                        value={planning.target_monthly_hours}
                        onChange={e => setPlanning(p => ({ ...p, target_monthly_hours: e.target.value }))}
                        placeholder={t('fleet.targetHoursPlaceholder')}
                        min="0"
                        step="0.5"
                      />
                    </Field>
                    <Field label={t('fleet.maxHoursMonth')}>
                      <Input
                        type="number"
                        value={planning.max_monthly_hours}
                        onChange={e => setPlanning(p => ({ ...p, max_monthly_hours: e.target.value }))}
                        placeholder={t('fleet.maxHoursPlaceholder')}
                        min="0"
                        step="0.5"
                      />
                    </Field>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t('fleet.minSalary')}>
                      <Input
                        type="number"
                        value={planning.planning_min_salary}
                        onChange={e => { setPlanning(p => ({ ...p, planning_min_salary: e.target.value })); setSalaryRangeError(''); }}
                        invalid={Boolean(salaryRangeError)}
                        placeholder={t('fleet.minSalaryPlaceholder')}
                        min="0"
                        step="0.01"
                      />
                    </Field>
                    <Field label={t('fleet.maxSalary')}>
                      <Input
                        type="number"
                        value={planning.planning_max_salary}
                        onChange={e => { setPlanning(p => ({ ...p, planning_max_salary: e.target.value })); setSalaryRangeError(''); }}
                        invalid={Boolean(salaryRangeError)}
                        placeholder={t('fleet.maxSalaryPlaceholder')}
                        min="0"
                        step="0.01"
                      />
                    </Field>
                    {salaryRangeError && (
                      <p role="alert" className="col-span-2 text-xs font-medium text-critical">{salaryRangeError}</p>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t('fleet.hourlyRate')}>
                      <Input
                        type="number"
                        value={planning.planning_hourly_rate}
                        onChange={e => setPlanning(p => ({ ...p, planning_hourly_rate: e.target.value }))}
                        placeholder={t('fleet.hourlyRatePlaceholder')}
                        min="0"
                        step="0.01"
                      />
                    </Field>
                    <Field label={t('fleet.planningPriority')} hint={t('fleet.planningPriorityHint')}>
                      <Input
                        type="number"
                        value={planning.planning_priority}
                        onChange={e => setPlanning(p => ({ ...p, planning_priority: e.target.value }))}
                        placeholder="100"
                        min="1"
                        max="999"
                      />
                    </Field>
                  </div>

                  <fieldset className="grid gap-3">
                    <legend className="sr-only">{t('fleet.planningSettings')}</legend>
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-fg">
                      <input
                        type="checkbox"
                        checked={planning.planning_enabled}
                        onChange={e => setPlanning(p => ({ ...p, planning_enabled: e.target.checked }))}
                        className={checkboxClass}
                      />
                      <span>
                        <span className="font-medium">{t('fleet.planningEnabled')}</span>
                        <span className="text-fg-muted">
                          {' · '}
                          {planning.planning_enabled ? t('overview.status.active') : t('overview.status.inactive')}
                        </span>
                      </span>
                    </label>

                    <div>
                      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-fg">
                        <input
                          type="checkbox"
                          checked={planning.can_cover_other_drivers}
                          onChange={e => setPlanning(p => ({ ...p, can_cover_other_drivers: e.target.checked }))}
                          className={checkboxClass}
                        />
                        <span>{t('fleet.canCoverOthers')}</span>
                      </label>
                      <p className="ml-7 text-xs text-fg-subtle">{t('fleet.canCoverOthersHint')}</p>
                    </div>
                  </fieldset>

                  <fieldset className="grid gap-4 border-t border-line pt-4">
                    <legend className="float-left mb-1 w-full text-sm font-semibold text-fg">{t('fleet.workWindowTitle')}</legend>
                    <p className="clear-both text-xs text-fg-subtle">{t('fleet.workWindowHint')}</p>

                    <div>
                      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-fg">
                        <input
                          type="checkbox"
                          checked={planning.is_full_day_available}
                          onChange={e => setPlanning(p => ({ ...p, is_full_day_available: e.target.checked }))}
                          className={checkboxClass}
                        />
                        <span>{t('fleet.fullDayAvailable')}</span>
                      </label>
                      <p className="ml-7 text-xs text-fg-subtle">{t('fleet.fullDayAvailableHint')}</p>
                    </div>

                    {planning.is_full_day_available ? (
                      <p className="rounded-control border border-line bg-sunken px-3 py-2 text-sm font-medium text-fg">
                        {t('fleet.workTimeAllDay')}
                      </p>
                    ) : (
                      <div className="grid grid-cols-2 gap-3">
                        <Field label={t('fleet.workStart')}>
                          <Input
                            type="time"
                            value={planning.work_window_start}
                            onChange={e => setPlanning(p => ({ ...p, work_window_start: e.target.value }))}
                          />
                        </Field>
                        <Field label={t('fleet.workEnd')}>
                          <Input
                            type="time"
                            value={planning.work_window_end}
                            onChange={e => setPlanning(p => ({ ...p, work_window_end: e.target.value }))}
                          />
                        </Field>
                      </div>
                    )}

                    <div role="group" aria-labelledby="driver-weekdays-label" className="grid gap-2">
                      <p id="driver-weekdays-label" className="text-[13px] font-medium text-fg-muted">
                        {t('fleet.allowedWeekdays')}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {WEEKDAY_OPTIONS.map(wd => {
                          const active = planning.allowed_weekdays.includes(wd.value);
                          return (
                            <button
                              key={wd.value}
                              type="button"
                              aria-pressed={active}
                              onClick={() => setPlanning(p => ({
                                ...p,
                                allowed_weekdays: active
                                  ? p.allowed_weekdays.filter(d => d !== wd.value)
                                  : [...p.allowed_weekdays, wd.value].sort((a, b) => a - b),
                              }))}
                              className={cn(
                                'h-8 min-w-11 rounded-control border px-3 text-xs font-semibold transition-colors [@media(pointer:coarse)]:h-10',
                                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                                active
                                  ? 'border-brand bg-brand text-brand-fg hover:bg-brand-hover'
                                  : 'border-line bg-raised text-fg-muted hover:bg-sunken hover:text-fg',
                              )}
                            >
                              {t(wd.label)}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div>
                      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-fg">
                        <input
                          type="checkbox"
                          checked={planning.allow_outside_shift_exceptions}
                          onChange={e => setPlanning(p => ({ ...p, allow_outside_shift_exceptions: e.target.checked }))}
                          className={checkboxClass}
                        />
                        <span>{t('fleet.allowOutsideExceptions')}</span>
                      </label>
                      <p className="ml-7 text-xs text-fg-subtle">{t('fleet.allowOutsideExceptionsHint')}</p>
                    </div>
                  </fieldset>
                </div>
              )}
            </div>
          </form>
        </SheetBody>

        <SheetFooter>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={formId}>
            <Save aria-hidden />
            {t('common.save')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};

export default DriverModal;
