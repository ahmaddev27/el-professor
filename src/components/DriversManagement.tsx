import React, { useState } from 'react';
import { Download, Pencil, Plus, Power, PowerOff, UserCheck, UserX, Users } from 'lucide-react';
import { Driver, DriverContact } from '../types/receipt';
import { DRIVER_LANGUAGE_NAMES, toDriverLanguage } from '../lib/driverLanguage';
import DriverModal, { DriverPlanningFields } from './DriverModal';
import { useColumnPickerExport } from '../contexts/ExportPickerContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useCompanyScope } from '../hooks/useCompanyScope';
import { pageWriteRights } from '../lib/pageWriteRights';
import {
  ACTIVE_DRIVER_STATUS,
  DEACTIVATED_DRIVER_STATUS,
  isDeactivatedDriver,
  selectableDrivers,
} from '../utils/driverStatus';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  KpiCard,
  PageHeader,
  Tooltip,
  type DataTableColumn,
} from './ui';

interface DriversManagementProps {
  drivers: Driver[];
  onAddDriver: (name: string, salaryRatio: number, personalnummer: string, gender: 'male' | 'female' | null, planning?: DriverPlanningFields, contact?: DriverContact) => void;
  // `contact` is optional on purpose: the status toggle calls this with four
  // arguments and must not rewrite an address nobody touched.
  onEditDriver: (id: string, name: string, salaryRatio: number, status?: 'active' | 'inactive', personalnummer?: string, gender?: 'male' | 'female' | null, planning?: DriverPlanningFields, contact?: DriverContact) => void;
  canEdit: (driver: Driver) => boolean;
}

const DriversManagement: React.FC<DriversManagementProps> = ({
  drivers,
  onAddDriver,
  onEditDriver,
  canEdit
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingDriver, setEditingDriver] = useState<Driver | undefined>();

  // The partition is total: `selectableDrivers` keeps everything not known to
  // be deactivated, so the two lists together are always every driver. The
  // earlier pair of `=== 'active'` / `=== 'inactive'` tests left a row whose
  // status the read did not carry in neither list, and this screen is the one
  // place a deactivated driver has to be visible.
  const activeDrivers = selectableDrivers(drivers);
  const inactiveDrivers = drivers.filter(isDeactivatedDriver);

  const { t } = useTranslation();
  const exportPicker = useColumnPickerExport();
  // No cap on how many drivers a company may have (owner, 21.10.2026, and
  // again on 26.10.2026 for cars: billing, never blocking).
  //
  // THE COMMENT THAT STOOD HERE UNTIL 26.10.2026 WAS FALSE, and the falsehood
  // cost five days of a live defect, so it is recorded rather than quietly
  // replaced. It said the cap "lived ONLY here, in the browser: no policy,
  // trigger or constraint enforced it, so removing it takes nothing else with
  // it." A trigger enforced it: `trg_enforce_driver_limit` on `drivers`,
  // enabled on production, refusing with P0001 and the German sentence
  // "Fahrerlimit erreicht. Ihr Abonnement erlaubt maximal N aktive Fahrer
  // (C Fahrzeuge × D)." So from 21.10.2026 the browser stopped explaining a
  // refusal that the database kept making, and a company at its allowance got
  // a raw subscription error with nothing on screen accounting for it.
  //
  // The trigger — and its sibling on `cars` — is dropped by
  // `20261026110000_bill_real_cars_drop_caps.sql`, so the sentence above is
  // true as of that migration and `tests/rls/fleet-caps-removed.sql` is what
  // keeps it true, with a negative control that puts the cap back and requires
  // the refusal to return.
  //
  // The cap was `companies.subscription_car_limit × company_settings.drivers_per_car_limit`
  // — NOT `subscription_plans.drivers_per_car_limit`, which feeds nothing.
  // Both columns are still stored: the first records the allowance of the plan
  // an operator assigned, the second is the owner's open question (Docs/design/
  // plan-system.md §12 question 6). Neither stops anyone. A company decides its
  // own number of drivers, and the fleet it runs is what its invoice charges.

  const handleSave = (
    name: string,
    salaryRatio: number,
    personalnummer: string,
    gender: 'male' | 'female' | null,
    planning: DriverPlanningFields,
    contact: DriverContact,
  ) => {
    if (editingDriver) {
      onEditDriver(editingDriver.id, name, salaryRatio, undefined, personalnummer, gender, planning, contact);
    } else {
      onAddDriver(name, salaryRatio, personalnummer, gender, planning, contact);
    }
    setIsModalOpen(false);
    setEditingDriver(undefined);
  };

  const handleEdit = (driver: Driver) => {
    setEditingDriver(driver);
    setIsModalOpen(true);
  };

  const handleToggleStatus = (driver: Driver) => {
    const newStatus = isDeactivatedDriver(driver) ? ACTIVE_DRIVER_STATUS : DEACTIVATED_DRIVER_STATUS;
    // No contact argument: this toggles the status and must not rewrite anything
    // else. `updateDriver` leaves both columns alone when none is passed, which is
    // what keeps a status change from clearing an address nobody touched.
    onEditDriver(driver.id, driver.name, driver.salaryRatio || 0, newStatus);
  };

  const handleExport = () => {
    // Sunday-indexed to match `allowed_weekdays` values as stored.
    const WEEKDAYS = [
      t('fleet.weekday.sun'), t('fleet.weekday.mon'), t('fleet.weekday.tue'), t('fleet.weekday.wed'),
      t('fleet.weekday.thu'), t('fleet.weekday.fri'), t('fleet.weekday.sat'),
    ];
    const yesNo = (v: unknown) => v === true ? t('common.yes') : v === false ? t('common.no') : '';
    exportPicker.table('drivers', {
      filename: `fahrer_${new Date().toISOString().split('T')[0]}`,
      sheetTitle: t('fleet.driversSheetTitle'),
      moduleName: t('nav.fahrer'),
      columns: [
        { key: 'name',                          label: t('fleet.driverName'),             width: 28 },
        { key: 'personalnummer',                label: t('fleet.personalnummerShort'),    width: 16 },
        { key: 'status',                        label: t('common.status'),                width: 12, format: v => v === 'active' ? t('overview.status.active') : t('overview.status.inactive') },
        { key: 'gender',                        label: t('fleet.salutation'),             width: 10, format: v => v === 'male' ? t('fleet.salutationMr') : v === 'female' ? t('fleet.salutationMrs') : '' },
        { key: 'employment_type',               label: t('fleet.employmentType'),         width: 22, format: v => v === 'company_owner' ? t('fleet.companyOwner') : v === 'employee' ? t('fleet.employed') : '' },
        // drivers.salary_ratio is numeric(5,4) between 0 and 1. Since 19.10.2026
        // the file carries no number format at all, so `fractionToPercent` in
        // excelExport.ts scales it and the cell holds 42, not 0.42 — which is
        // why the unit belongs in the header. It is appended here and not in
        // the dictionary, because the screen uses the same key for its label.
        { key: 'salaryRatio',                   label: `${t('fleet.salaryShare')} (%)`,   width: 16, align: 'right' as const, type: 'percent' },
        { key: 'planning_enabled',              label: t('fleet.planningActive'),         width: 14, format: yesNo },
        // Euros, not cents: planning_hourly_rate is numeric and both salary
        // bounds are numeric(10,2), all of them stored as euro amounts.
        { key: 'planning_hourly_rate',          label: t('fleet.hourlyRate'),             width: 16, align: 'right' as const, type: 'money' },
        { key: 'planning_min_salary',           label: t('fleet.minSalary'),              width: 16, align: 'right' as const, type: 'money' },
        { key: 'planning_max_salary',           label: t('fleet.maxSalary'),              width: 16, align: 'right' as const, type: 'money' },
        // Both hour columns are plain `numeric`, so a half hour is possible.
        { key: 'driver_usage_type',             label: t('fleet.usageType'),              width: 20, format: v => v === 'regular' ? t('fleet.regular') : v === 'coverage_only' ? t('fleet.coverageOnly') : '' },
        { key: 'can_cover_other_drivers',       label: t('fleet.canCover'),               width: 14, format: yesNo },
        { key: 'planning_priority',             label: t('fleet.priority'),               width: 12, align: 'right' as const, type: 'integer' },
        { key: 'allowed_weekdays',              label: t('fleet.allowedWeekdaysColumn'),  width: 28, format: v => Array.isArray(v) ? (v as number[]).map(n => WEEKDAYS[n] ?? n).join(', ') : v == null ? t('common.all') : '' },
        { key: 'work_window_start',             label: t('fleet.workWindowFrom'),         width: 18, format: v => v != null ? String(v) : '' },
        { key: 'work_window_end',               label: t('fleet.workWindowTo'),           width: 18, format: v => v != null ? String(v) : '' },
        { key: 'is_full_day_available',         label: t('fleet.fullDayAvailableShort'),  width: 18, format: yesNo },
        { key: 'allow_outside_shift_exceptions',label: t('fleet.exceptionsAllowed'),      width: 18, format: yesNo },
        // These two keys are camelCase because the rows below are the objects
        // `mapDriverRow` builds, not raw `drivers` rows — its explicit key list
        // is what every key here has to appear in. `createdAt` was missing from
        // it, and because `rows` is cast to Record<string, unknown> the type
        // system could not see it: the column exported 40 blank cells under
        // "Erstellt am" for a fleet of 40. `driverRow.test.ts` reads these keys
        // out of this file and fails when the mapper stops emitting one.
        { key: 'createdBy',                     label: t('fleet.createdBy'),              width: 28 },
        { key: 'createdAt',                     label: t('fleet.createdAt'),              width: 16, format: v => v ? new Date(v as string).toLocaleDateString('de-DE') : '' },
      ],
      rows: drivers as unknown as Record<string, unknown>[],
      // The totals row's LABEL, not a figure in the Fahrername column: keyed on
      // the first column it was discarded unrendered, so the file said
      // "Gesamt (N Einträge)" instead. `totals: {}` keeps the row — none of the
      // per-driver figures below is a column this list sums.
      labels: {
        totalsRow: t('fleet.driversTotalsLine', {
          total: drivers.length, active: activeDrivers.length, inactive: inactiveDrivers.length,
        }),
      },
      totals: {},
    });
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the screen's logic and is unchanged, less the hover-row
  // state, which only painted a row. Everything below only draws. It asks
  // useCompanyScope() for `canCreate` so the add button is not offered where no
  // write is (a read context, a role without the right, plan 3.4b); FahrerPage's
  // handleAddDriver refuses such a caller as before. There is no confirmation in
  // front of the bin: it deletes at once, as it always has.

  const scope = useCompanyScope();
  const { canCreate } = pageWriteRights('drivers', scope);

  const addButton = (size?: 'sm') =>
    canCreate ? (
      <Button
        size={size}
        onClick={() => setIsModalOpen(true)}
      >
        <Plus aria-hidden />
        {t('fleet.newDriver')}
      </Button>
    ) : null;

  const statusBadge = (driver: Driver) =>
    !isDeactivatedDriver(driver) ? (
      <Badge tone="positive">
        <UserCheck aria-hidden />
        {t('overview.status.active')}
      </Badge>
    ) : (
      <Badge tone="neutral">
        <UserX aria-hidden />
        {t('overview.status.inactive')}
      </Badge>
    );

  const columns: DataTableColumn<Driver>[] = [
    {
      id: 'name',
      header: t('fleet.driverName'),
      value: driver => driver.name,
      sortable: true,
      cell: driver => (
        <span className="grid min-w-0 gap-0.5 py-2">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold text-fg">{driver.name}</span>
            {driver.employment_type === 'company_owner' && (
              <Badge tone="brand">
                <span className="hidden md:inline">{t('fleet.companyOwner')}</span>
                <span className="md:hidden">{t('fleet.inhaber')}</span>
              </Badge>
            )}
          </span>
          <span className="text-[13px] tabular-nums text-fg-subtle">
            {driver.personalnummer ? t('fleet.persNr', { number: driver.personalnummer }) : t('fleet.noPersonalnummer')}
          </span>
          {/* A phone has no room for the status column beside three row
              actions; the status moves here. */}
          <span className="pt-0.5 sm:hidden">{statusBadge(driver)}</span>
        </span>
      ),
      className: 'pl-3 pr-1 sm:min-w-[9rem] sm:px-4',
    },
    {
      id: 'status',
      header: t('common.status'),
      value: driver => driver.status,
      sortable: true,
      cell: statusBadge,
      hideBelow: 'sm',
    },
    {
      id: 'mailLanguage',
      header: t('fleet.mailLanguage'),
      value: driver => toDriverLanguage(driver.preferred_language),
      sortable: true,
      cell: driver => (
        // The language's own name, so `dir="auto"` keeps Arabic reading right.
        <span dir="auto" className="text-fg-muted">
          {DRIVER_LANGUAGE_NAMES[toDriverLanguage(driver.preferred_language)]}
        </span>
      ),
      hideBelow: 'lg',
    },
    {
      id: 'createdBy',
      header: t('fleet.createdBy'),
      cell: driver => (
        <span className="block max-w-[16rem] truncate text-fg-muted" title={driver.createdBy || undefined}>
          {driver.createdBy || t('common.unknown')}
        </span>
      ),
      hideBelow: 'lg',
    },
  ];

  const anyRowWritable = drivers.some(driver => canEdit(driver));

  const rowActions = (driver: Driver) => (
    <>
      {canEdit(driver) ? (
        <Tooltip content={isDeactivatedDriver(driver) ? t('fleet.activate') : t('fleet.deactivate')}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={
              isDeactivatedDriver(driver)
                ? t('fleet.activateDriverAria', { name: driver.name })
                : t('fleet.deactivateDriverAria', { name: driver.name })
            }
            onClick={() => canEdit(driver) && handleToggleStatus(driver)}
          >
            {isDeactivatedDriver(driver) ? <Power aria-hidden /> : <PowerOff aria-hidden />}
          </Button>
        </Tooltip>
      ) : null}
      {canEdit(driver) ? (
        <Tooltip content={t('common.edit')}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('fleet.editDriverAria', { name: driver.name })}
            onClick={() => canEdit(driver) && handleEdit(driver)}
          >
            <Pencil aria-hidden />
          </Button>
        </Tooltip>
      ) : null}
    </>
  );

  return (
    <div className="font-ui">
      <PageHeader
        title={t('nav.fahrer')}
        description={
          <>
            {t('fleet.driversDescription')}
            <span aria-hidden className="mx-1.5 text-fg-subtle">·</span>
            <span className="whitespace-nowrap">
              {t('fleet.activeDriversCount', { active: activeDrivers.length })}
            </span>
          </>
        }
        actions={
          <>
            <Button variant="secondary" onClick={handleExport}>
              <Download aria-hidden />
              {t('common.exportExcelShort')}
            </Button>
            {addButton()}
          </>
        }
      />

      {/* grid-cols-1 is minmax(0, 1fr): a bare grid sizes its column to the
          widest child's content, and the table alone would push the page past
          375 px. */}
      <div className="grid grid-cols-1 gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <KpiCard label={t('fleet.activeDrivers')} value={activeDrivers.length} icon={UserCheck} />
          <KpiCard label={t('fleet.inactiveDrivers')} value={inactiveDrivers.length} icon={UserX} />
          <KpiCard label={t('overview.common.gesamt')} value={drivers.length} icon={Users} />
        </div>

        {drivers.length === 0 ? (
          <Card>
            <EmptyState icon={Users} title={t('fleet.noDrivers')} description={t('fleet.noDriversHint')} action={addButton()} />
          </Card>
        ) : (
          <DataTable
            caption={t('nav.fahrer')}
            columns={columns}
            rows={drivers}
            getRowId={driver => driver.id}
            rowActions={anyRowWritable ? rowActions : undefined}
            rowActionsLabel={t('fleet.actions')}
          />
        )}

        {/* Where "delete" used to be, and this is the permanent answer (owner,
            25.10.2026), so the sentence says both halves: what survives, and
            what deactivating actually does. The first half is not a
            reassurance — eight foreign keys CASCADE off `drivers`, one of them
            `salary_cash_receipts`, whose GQ-YYYY-NNNN numbers are gapless per
            company and year and go to a Steuerberater. The second half is new
            behaviour a user has to be told about: a deactivated driver leaves
            every selection list, the monthly plan and the Fahrtenbuch among
            them. */}
        <p className="text-sm text-fg-muted">{t('fleet.deactivateNotDelete')}</p>
        <p className="text-sm text-fg-muted">{t('fleet.deactivateHidesFromLists')}</p>
      </div>

      <DriverModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingDriver(undefined);
        }}
        onSave={handleSave}
        driver={editingDriver}
        title={editingDriver ? t('fleet.editDriver') : t('fleet.newDriver')}
      />
    </div>
  );
};

export default DriversManagement;
