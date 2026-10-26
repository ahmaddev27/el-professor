import { useState, useEffect } from 'react';
import { Car as CarIcon, Download, Pencil, Plus, ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX, Trash2, type LucideIcon } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import { usePlan } from '../contexts/PlanContext';
import CarModal from './CarModal';
import type { CarWithDrivers, TuevInfo, TuevStatus } from '../types/car';
import { driverNameWithStatus } from '../utils/driverStatus';
import { getTuevStatus } from '../types/car';
import { useColumnPickerExport } from '../contexts/ExportPickerContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useCompanyScope } from '../hooks/useCompanyScope';
import { deleteChecked } from '../lib/writeOutcome';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import {
  Alert,
  Badge,
  Button,
  Card,
  cn,
  ConfirmDialog,
  DataTable,
  EmptyState,
  PageHeader,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  type DataTableColumn,
} from './ui';

type TuevFilter = 'all' | TuevStatus;

// `label` and `shortLabel` hold TranslationKeys: this map is module-level and
// t() is a hook value. Every consumer resolves them. The Excel export reads
// `label` too, which is why the words live here and the look lives apart, in
// TUEV_PRESENTATION below: phase 5 changed only the look.
const TUEV_CONFIG: Record<TuevStatus, {
  label: TranslationKey;
  shortLabel: TranslationKey;
}> = {
  gueltig: {
    label: 'fleet.tuevStatus.valid',
    shortLabel: 'fleet.tuevStatus.valid',
  },
  bald_ablaufend: {
    label: 'fleet.tuevStatus.expiringSoon',
    shortLabel: 'fleet.tuevStatus.expiringSoonShort',
  },
  abgelaufen: {
    label: 'fleet.tuevStatus.expired',
    shortLabel: 'fleet.tuevStatus.expired',
  },
  unbekannt: {
    label: 'fleet.tuevStatus.unknown',
    shortLabel: 'common.unknown',
  },
};

type Tone = 'positive' | 'caution' | 'critical' | 'neutral';

const TUEV_PRESENTATION: Record<TuevStatus, { tone: Tone; icon: LucideIcon }> = {
  gueltig: { tone: 'positive', icon: ShieldCheck },
  bald_ablaufend: { tone: 'caution', icon: ShieldAlert },
  abgelaufen: { tone: 'critical', icon: ShieldX },
  unbekannt: { tone: 'neutral', icon: ShieldQuestion },
};

/** A tab's count badge takes its status's colour, and only while it counts something. */
const FILTER_TONE: Record<TuevFilter, Tone> = {
  all: 'neutral',
  abgelaufen: 'critical',
  bald_ablaufend: 'caution',
  gueltig: 'positive',
  unbekannt: 'neutral',
};

const LIMIT_ALERT_ID = 'fleet-car-limit';

/** The status in words with an icon, and the day count when it matters. */
function TuevStatusCell({ info }: { info: TuevInfo }) {
  const { t, tPlural } = useTranslation();
  const { tone, icon: Icon } = TUEV_PRESENTATION[info.status];
  const days = info.daysLeft;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1">
      <Badge tone={tone}>
        <Icon aria-hidden />
        {t(TUEV_CONFIG[info.status].label)}
      </Badge>
      {days !== null && info.status !== 'gueltig' ? (
        <span className="whitespace-nowrap text-[13px] tabular-nums text-fg-subtle">
          {days < 0
            ? tPlural({ one: 'fleet.tuevCountdown.overdue.one', other: 'fleet.tuevCountdown.overdue.other' }, Math.abs(days))
            : tPlural({ one: 'fleet.tuevCountdown.left.one', other: 'fleet.tuevCountdown.left.other' }, days)}
        </span>
      ) : null}
    </span>
  );
}

export default function CarsManagement() {
  const [cars, setCars] = useState<CarWithDrivers[]>([]);
  const [loading, setLoading] = useState(true);
  /*
    The rule: an empty fleet is a claim about the company's data, and after a
    read that failed the screen has made no such observation. `loadCars`' catch
    only logged and raised a toast, so `cars` stayed `[]` and the Excel export
    wrote a fleet of nought into a file that leaves the browser and reaches an
    accountant. One failure state per screen (CLAUDE.md's batch-2 rule), cleared
    where the load starts and set in the existing catch.
  */
  const [loadFailed, setLoadFailed] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCar, setEditingCar] = useState<CarWithDrivers | null>(null);
  const [tuevFilter, setTuevFilter] = useState<TuevFilter>('all');
  const [deleteConfirmation, setDeleteConfirmation] = useState<{ isOpen: boolean; carId: string | null; kennzeichen: string }>({
    isOpen: false,
    carId: null,
    kennzeichen: '',
  });

  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const { showToast } = useToast();
  // The database gates `cars` by page right, and a refused DELETE or UPDATE is
  // silent (see lib/writeOutcome.ts), so the screen asks the same question.
  const mayEdit = useCompanyScope().can('cars', 'edit');
  const { planState } = usePlan();
  const { t, tPlural } = useTranslation();
  const exportPicker = useColumnPickerExport();

  useEffect(() => {
    loadCars();
  }, []);

  const loadCars = async () => {
    try {
      setLoading(true);
      setLoadFailed(false);

      const { data: carsData, error: carsError } = await supabase
        .from('cars')
        .select('*')
        .eq('company_id', companyId)
        .order('kennzeichen');

      if (carsError) throw carsError;

      const { data: assignmentsData, error: assignmentsError } = await supabase
        .from('car_driver_assignments')
        .select(`car_id, driver_id, drivers (id, name)`)
        .eq('company_id', companyId);

      if (assignmentsError) throw assignmentsError;

      // Every driver, the deactivated included, and `status` with them: this
      // resolves the names of the drivers each vehicle is CURRENTLY assigned to,
      // and a filter here would drop the assignment silently at the
      // `.filter(d => d !== null)` below, leaving the vehicle looking unassigned.
      // The name is marked instead, so the operator can see what to reassign.
      const { data: driversData, error: driversError } = await supabase
        .from('drivers')
        .select('id, name, status')
        .eq('company_id', companyId);

      if (driversError) throw driversError;

      const driverMap = new Map(driversData?.map(d => [d.id, d]) || []);

      const carsWithDrivers: CarWithDrivers[] = (carsData || []).map(car => {
        const carAssignments = (assignmentsData || []).filter(a => a.car_id === car.id);
        // `flatMap` rather than map-then-filter-with-a-predicate: the predicate
        // had to restate the row's exact `status` type to stay assignable, and
        // getting that wrong is a type error for a line that only drops nulls.
        const drivers = carAssignments.flatMap(a => {
          const driver = driverMap.get(a.driver_id);
          return driver ? [{ id: driver.id, name: driver.name, status: driver.status }] : [];
        });

        return { ...car, drivers };
      });

      setCars(carsWithDrivers);
    } catch (error: any) {
      console.error('Error loading cars:', error);
      showToast('error', t('fleet.carsLoadFailed', { error: error.message }));
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  };

  const activeCars = cars.filter(c => (c as any).status !== 'inactive');
  const carLimit = planState.carLimit;
  const carLimitReached = activeCars.length >= carLimit;

  const handleAddCar = () => {
    if (carLimitReached) {
      showToast('error', t('fleet.carLimitReachedToast', { limit: carLimit }));
      return;
    }
    setEditingCar(null);
    setIsModalOpen(true);
  };
  const handleEditCar   = (car: CarWithDrivers) => { setEditingCar(car); setIsModalOpen(true); };
  const handleModalClose   = () => { setIsModalOpen(false); setEditingCar(null); };
  const handleModalSuccess = () => { loadCars(); handleModalClose(); };

  const handleDeleteCar = (car: CarWithDrivers) => {
    setDeleteConfirmation({ isOpen: true, carId: car.id, kennzeichen: car.kennzeichen });
  };

  const confirmDelete = async () => {
    if (!deleteConfirmation.carId) return;
    try {
      const carId = deleteConfirmation.carId;
      const outcome = await deleteChecked(supabase, 'cars', q => q.eq('id', carId));
      if (outcome === 'refused') {
        showToast('error', t('common.writeRefused'));
        return;
      }
      if (outcome === 'gone') showToast('error', t('common.writeAlreadyGone'));
      else showToast('success', t('fleet.carDeleted'));
      loadCars();
    } catch (error: any) {
      console.error('Error deleting car:', error);
      showToast('error', t('fleet.carDeleteFailed', { error: error.message }));
    } finally {
      setDeleteConfirmation({ isOpen: false, carId: null, kennzeichen: '' });
    }
  };

  // ── Filtered list ─────────────────────────────────────────────────────────
  const filteredCars = tuevFilter === 'all'
    ? cars
    : cars.filter(c => getTuevStatus(c.tuev_gueltig_bis).status === tuevFilter);

  // ── Summary counts ────────────────────────────────────────────────────────
  const counts = {
    abgelaufen:    cars.filter(c => getTuevStatus(c.tuev_gueltig_bis).status === 'abgelaufen').length,
    bald_ablaufend: cars.filter(c => getTuevStatus(c.tuev_gueltig_bis).status === 'bald_ablaufend').length,
    gueltig:       cars.filter(c => getTuevStatus(c.tuev_gueltig_bis).status === 'gueltig').length,
    unbekannt:     cars.filter(c => getTuevStatus(c.tuev_gueltig_bis).status === 'unbekannt').length,
  };

  const handleExport = () => {
    exportPicker.table('cars', {
      filename: `fahrzeuge_${new Date().toISOString().split('T')[0]}`,
      sheetTitle: t('fleet.carsSheetTitle'),
      moduleName: t('nav.cars'),
      filterSummary: tuevFilter !== 'all'
        ? [t('fleet.tuevStatusFilter', { status: t(TUEV_CONFIG[tuevFilter as TuevStatus].label) })]
        : [],
      columns: [
        { key: 'kennzeichen',      label: t('werkstatt.plate'),         width: 18 },
        { key: 'drivers',          label: t('fleet.assignedDrivers'),   width: 36, format: v => (v as { name: string; status?: string | null }[] ?? []).map(d => driverNameWithStatus(d, t)).join(', ') || '—' },
        { key: 'tuev_gueltig_bis', label: t('fleet.tuevValidUntil'),    width: 16, format: v => v ? new Date(v as string).toLocaleDateString('de-DE') : '—' },
        { key: 'tuev_status',      label: t('fleet.tuevStatusColumn'),  width: 18 },
        { key: 'letzte_hu',        label: t('fleet.lastHu'),            width: 16, format: v => v ? new Date(v as string).toLocaleDateString('de-DE') : '—' },
        { key: 'created_at',       label: t('fleet.createdAt'),         width: 16, format: v => v ? new Date(v as string).toLocaleDateString('de-DE') : '' },
      ],
      rows: filteredCars.map(c => {
        const { status, daysLeft } = getTuevStatus(c.tuev_gueltig_bis);
        const label = t(TUEV_CONFIG[status].label);
        const statusLabel = daysLeft !== null && daysLeft >= 0
          ? t('fleet.tuevDaysRemaining', { label, days: daysLeft })
          : daysLeft !== null
          ? t('fleet.tuevDaysOverdue', { label, days: Math.abs(daysLeft) })
          : label;
        return { ...(c as unknown as Record<string, unknown>), tuev_status: statusLabel };
      }),
      // This line is the totals row's LABEL, not a figure in the Kennzeichen
      // column: keyed on the first column it was discarded unrendered, so the
      // file said "Gesamt (N Einträge)" instead. `totals: {}` keeps the row —
      // the table has no column to total.
      labels: { totalsRow: t('fleet.carsTotal', { count: filteredCars.length }) },
      totals: {},
    });
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the screen's logic and is unchanged; everything below
  // only draws it.

  const columns: DataTableColumn<CarWithDrivers>[] = [
    {
      id: 'kennzeichen',
      header: t('werkstatt.plate'),
      value: car => car.kennzeichen,
      sortable: true,
      cell: car => <span className="whitespace-nowrap font-semibold tabular-nums">{car.kennzeichen}</span>,
      // At 375 px the plate, the status and both row actions share 335 px; with
      // the table's standard padding the delete button fell off the edge (the
      // approved prototype has the same clipping). Tighter only on a phone.
      className: 'pl-3 pr-1 sm:px-4',
    },
    {
      id: 'drivers',
      header: t('fleet.assignedDrivers'),
      value: car => car.drivers.map(driver => driverNameWithStatus(driver, t)).join(', '),
      cell: car =>
        car.drivers.length > 0 ? (
          car.drivers.map(driver => driverNameWithStatus(driver, t)).join(', ')
        ) : (
          <span className="text-fg-subtle">{t('fleet.noDriversAssigned')}</span>
        ),
      hideBelow: 'md',
      className: 'min-w-[12rem]',
    },
    {
      id: 'tuevValidUntil',
      header: t('fleet.tuevValidUntil'),
      kind: 'date',
      value: car => car.tuev_gueltig_bis,
      sortable: true,
      hideBelow: 'sm',
    },
    {
      id: 'tuevStatus',
      header: t('fleet.tuevStatusColumn'),
      value: car => getTuevStatus(car.tuev_gueltig_bis).daysLeft,
      sortable: true,
      cell: car => <TuevStatusCell info={getTuevStatus(car.tuev_gueltig_bis)} />,
      className: 'pl-2 pr-0 sm:px-4',
    },
    { id: 'lastHu', header: t('fleet.lastHu'), kind: 'date', value: car => car.letzte_hu, sortable: true, hideBelow: 'lg' },
  ];

  const rowActions = (car: CarWithDrivers) => (
    <>
      <Tooltip content={t('common.edit')}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('fleet.editCarAria', { plate: car.kennzeichen })}
          onClick={() => handleEditCar(car)}
        >
          <Pencil aria-hidden />
        </Button>
      </Tooltip>
      <Tooltip content={t('common.delete')}>
        <Button
          variant="ghost"
          size="icon-sm"
          className="hover:text-critical"
          aria-label={t('fleet.deleteCarAria', { plate: car.kennzeichen })}
          onClick={() => handleDeleteCar(car)}
        >
          <Trash2 aria-hidden />
        </Button>
      </Tooltip>
    </>
  );

  if (loading) {
    return (
      <div className="font-ui">
        <PageHeader title={t('nav.cars')} description={t('fleet.carsSubtitle')} />
        <DataTable caption={t('nav.cars')} columns={columns} rows={[]} getRowId={car => car.id} loading />
      </div>
    );
  }

  const filterTabs: { key: TuevFilter; label: string; count: number }[] = [
    { key: 'all',            label: t('common.all'),                          count: cars.length },
    { key: 'abgelaufen',     label: t(TUEV_CONFIG.abgelaufen.shortLabel),     count: counts.abgelaufen },
    { key: 'bald_ablaufend', label: t(TUEV_CONFIG.bald_ablaufend.shortLabel), count: counts.bald_ablaufend },
    { key: 'gueltig',        label: t(TUEV_CONFIG.gueltig.shortLabel),        count: counts.gueltig },
    { key: 'unbekannt',      label: t(TUEV_CONFIG.unbekannt.shortLabel),      count: counts.unbekannt },
  ];

  return (
    <div className="font-ui">
      <PageHeader
        title={t('nav.cars')}
        description={
          <>
            {t('fleet.carsSubtitle')}
            <span aria-hidden className="mx-1.5 text-fg-subtle">·</span>
            <span className={cn('whitespace-nowrap', carLimitReached && 'font-medium text-critical')}>
              {t('fleet.activeCarsOfLimit', { active: activeCars.length, limit: carLimit })}
            </span>
          </>
        }
        actions={
          <>
            <Button variant="secondary" onClick={handleExport} disabled={loadFailed}>
              <Download aria-hidden />
              {t('common.exportExcelShort')}
            </Button>
            <Button
              onClick={handleAddCar}
              disabled={carLimitReached}
              aria-describedby={carLimitReached ? LIMIT_ALERT_ID : undefined}
            >
              <Plus aria-hidden />
              {t('fleet.addCar')}
            </Button>
          </>
        }
      />

      {/* grid-cols-1 is minmax(0, 1fr): a bare grid sizes its column to the
          widest child's content, and the tab row alone would push the page
          past 375 px. */}
      <div className="grid grid-cols-1 gap-4">
        {carLimitReached && (
          <Alert id={LIMIT_ALERT_ID} tone="critical" icon={CarIcon} title={t('fleet.carLimitReachedHeading')}>
            {t('fleet.carLimitReachedBody', { limit: carLimit })}
          </Alert>
        )}

        {cars.length > 0 && (counts.abgelaufen > 0 || counts.bald_ablaufend > 0) && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {counts.abgelaufen > 0 && (
              <Alert
                tone="critical"
                role="status"
                icon={ShieldX}
                title={tPlural({ one: 'fleet.tuevExpiredBanner.one', other: 'fleet.tuevExpiredBanner.other' }, counts.abgelaufen)}
              >
                {t('fleet.tuevExpiredHint')}
              </Alert>
            )}
            {counts.bald_ablaufend > 0 && (
              <Alert
                tone="caution"
                icon={ShieldAlert}
                title={tPlural({ one: 'fleet.tuevExpiringBanner.one', other: 'fleet.tuevExpiringBanner.other' }, counts.bald_ablaufend)}
              >
                {t('fleet.tuevExpiringHint')}
              </Alert>
            )}
          </div>
        )}

        {cars.length === 0 ? (
          <Card>
            <EmptyState
              icon={CarIcon}
              title={t('fleet.noCars')}
              description={t('fleet.noCarsHint')}
              action={
                <Button onClick={handleAddCar}>
                  <Plus aria-hidden />
                  {t('fleet.addCar')}
                </Button>
              }
            />
          </Card>
        ) : (
          <Tabs value={tuevFilter} onValueChange={value => setTuevFilter(value as TuevFilter)}>
            <TabsList aria-label={t('fleet.tuevStatusColumn')}>
              {filterTabs.map(tab => (
                <TabsTrigger key={tab.key} value={tab.key}>
                  {tab.label}
                  <Badge tone={tab.count > 0 ? FILTER_TONE[tab.key] : 'neutral'} className="px-1.5 tabular-nums">
                    {tab.count}
                  </Badge>
                </TabsTrigger>
              ))}
            </TabsList>
            {/* Only the active panel mounts, and filteredCars is that panel's list. */}
            {filterTabs.map(tab => (
              <TabsContent key={tab.key} value={tab.key} className="mt-4">
                <DataTable
                  caption={t('fleet.carsCaption', { filter: tab.label })}
                  columns={columns}
                  rows={filteredCars}
                  getRowId={car => car.id}
                  rowActions={mayEdit ? rowActions : undefined}
                  rowActionsLabel={t('fleet.actions')}
                  emptyState={
                    <EmptyState size="sm" icon={CarIcon} title={t('fleet.noCarsForFilter')} description={t('fleet.noCarsFilterHint')} />
                  }
                />
              </TabsContent>
            ))}
          </Tabs>
        )}
      </div>

      {isModalOpen && (
        <CarModal car={editingCar} onClose={handleModalClose} onSuccess={handleModalSuccess} />
      )}

      <ConfirmDialog
        open={deleteConfirmation.isOpen}
        title={t('fleet.deleteCarTitle')}
        description={t('fleet.deleteCarMessage', { kennzeichen: deleteConfirmation.kennzeichen })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        icon={Trash2}
        onConfirm={confirmDelete}
        onClose={() => setDeleteConfirmation({ isOpen: false, carId: null, kennzeichen: '' })}
      />
    </div>
  );
}
