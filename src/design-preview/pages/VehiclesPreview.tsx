import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Car, CheckCircle2, Download, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from '../../contexts/LanguageContext';
import {
  Button,
  DataTable,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  Badge,
  type DataTableColumn,
} from '../../components/ui';
import {
  PREVIEW_CAR_LIMIT,
  PREVIEW_DRIVERS,
  PREVIEW_PERIOD,
  PREVIEW_TODAY,
  PREVIEW_VEHICLES,
  centsToEuros,
  driverName,
  monthLabel,
  tuevOn,
  type PreviewVehicle,
  type TuevInfo,
} from '../sampleData';
import { TuevStatus } from '../TuevStatus';

type Filter = 'all' | 'expiringSoon' | 'expired';

const FILTERS: Filter[] = ['all', 'expiringSoon', 'expired'];
const FILTER_TONE = { all: 'neutral', expiringSoon: 'caution', expired: 'critical' } as const;

const NO_DRIVER = 'none';

// Existing records hold both "B-YA 1234" and "B-YA-1234"; accept either.
const PLATE_PATTERN = /^[A-ZÄÖÜ]{1,3}-[A-Z]{1,2}[- ][1-9]\d{0,3}[EH]?$/;

interface VehicleRow extends PreviewVehicle {
  tuev: TuevInfo;
}

interface FormState {
  plate: string;
  tuevValidUntil: string;
  lastHu: string;
  driverOne: string;
  driverTwo: string;
}

interface FormErrors {
  plate?: string;
  driverTwo?: string;
}

const normalizePlate = (value: string) => value.trim().toUpperCase().replace(/\s+/g, ' ');

function toForm(vehicle: PreviewVehicle | null): FormState {
  return {
    plate: vehicle?.plate ?? '',
    tuevValidUntil: vehicle?.tuevValidUntil ?? '',
    lastHu: vehicle?.lastHu ?? '',
    driverOne: vehicle?.driverIds[0] ?? NO_DRIVER,
    driverTwo: vehicle?.driverIds[1] ?? NO_DRIVER,
  };
}

/** A year after the given date, or after today; 29 February lands on the 28th. */
function plusOneYear(isoDate: string): string {
  const base = isoDate || PREVIEW_TODAY;
  const monthDay = base.slice(5, 10) === '02-29' ? '02-28' : base.slice(5, 10);
  return `${Number(base.slice(0, 4)) + 1}-${monthDay}`;
}

export default function VehiclesPreview() {
  const { t, language } = useTranslation();
  const [vehicles, setVehicles] = useState<PreviewVehicle[]>(PREVIEW_VEHICLES);
  const [filter, setFilter] = useState<Filter>('all');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => toForm(null));
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitCount, setSubmitCount] = useState(0);
  const [deleting, setDeleting] = useState<PreviewVehicle | null>(null);
  const [status, setStatus] = useState('');
  const formRef = useRef<HTMLFormElement>(null);

  const rows = useMemo<VehicleRow[]>(() => vehicles.map(vehicle => ({ ...vehicle, tuev: tuevOn(vehicle.tuevValidUntil) })), [vehicles]);

  const rowsFor = (value: Filter) => (value === 'all' ? rows : rows.filter(row => row.tuev.state === value));

  // After a failed save, move focus to the first field that needs attention.
  useEffect(() => {
    if (submitCount === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [submitCount]);

  const month = monthLabel(PREVIEW_PERIOD.year, PREVIEW_PERIOD.monthIndex, language, false);

  const filterLabel: Record<Filter, string> = {
    all: t('common.all'),
    expiringSoon: t('fleet.tuevStatus.expiringSoon'),
    expired: t('fleet.tuevStatus.expired'),
  };

  const openEditor = (vehicle: PreviewVehicle | null) => {
    setEditingId(vehicle?.id ?? null);
    setForm(toForm(vehicle));
    setErrors({});
    setStatus('');
    setEditorOpen(true);
  };

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm(current => ({ ...current, [key]: value }));
  };

  const validate = (state: FormState): FormErrors => {
    const found: FormErrors = {};
    const plate = normalizePlate(state.plate);
    if (!plate) {
      found.plate = t('fleet.kennzeichenRequired');
    } else if (!PLATE_PATTERN.test(plate)) {
      found.plate = t('preview.cars.plateInvalid');
    } else if (vehicles.some(vehicle => vehicle.id !== editingId && normalizePlate(vehicle.plate) === plate)) {
      found.plate = t('fleet.kennzeichenExists');
    }
    if (state.driverTwo !== NO_DRIVER && state.driverTwo === state.driverOne) {
      found.driverTwo = t('preview.cars.sameDriver');
    }
    return found;
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setSubmitCount(count => count + 1);
      return;
    }

    const existing = vehicles.find(vehicle => vehicle.id === editingId);
    const saved: PreviewVehicle = {
      id: existing?.id ?? `new-${vehicles.length + 1}`,
      plate: normalizePlate(form.plate),
      driverIds: [form.driverOne, form.driverTwo].filter(id => id !== NO_DRIVER),
      tuevValidUntil: form.tuevValidUntil || null,
      lastHu: form.lastHu || null,
      revenueCents: existing?.revenueCents ?? null,
    };
    setVehicles(current => (existing ? current.map(vehicle => (vehicle.id === existing.id ? saved : vehicle)) : [saved, ...current]));
    setEditorOpen(false);
    setStatus(t('preview.cars.saved'));
  };

  const confirmDelete = () => {
    if (!deleting) return;
    setVehicles(current => current.filter(vehicle => vehicle.id !== deleting.id));
    setDeleting(null);
  };

  const columns: DataTableColumn<VehicleRow>[] = [
    {
      id: 'plate',
      header: t('werkstatt.plate'),
      value: row => row.plate,
      cell: row => <span className="font-semibold tabular-nums">{row.plate}</span>,
      sortable: true,
    },
    {
      id: 'drivers',
      header: t('fleet.assignedDrivers'),
      value: row => row.driverIds.map(driverName).join(', '),
      cell: row =>
        row.driverIds.length > 0 ? (
          row.driverIds.map(driverName).join(', ')
        ) : (
          <span className="text-fg-subtle">{t('fleet.noDriversAssigned')}</span>
        ),
      hideBelow: 'md',
      className: 'min-w-[13rem]',
    },
    { id: 'tuevValidUntil', header: t('fleet.tuevValidUntil'), kind: 'date', value: row => row.tuevValidUntil, sortable: true, hideBelow: 'sm' },
    {
      id: 'tuevStatus',
      header: t('fleet.tuevStatusColumn'),
      value: row => row.tuev.daysLeft,
      cell: row => <TuevStatus info={row.tuev} />,
      sortable: true,
    },
    { id: 'lastHu', header: t('fleet.lastHu'), kind: 'date', value: row => row.lastHu, sortable: true, hideBelow: 'lg' },
    {
      id: 'revenue',
      header: t('preview.cars.revenue', { month }),
      kind: 'currency',
      value: row => (row.revenueCents === null ? null : centsToEuros(row.revenueCents)),
      sortable: true,
      // At tablet width the plate, drivers and TÜV columns already fill the
      // row; a cut-off amount is worse than none.
      hideBelow: 'lg',
    },
  ];

  const rowActions = (row: VehicleRow) => (
    <>
      <Tooltip content={t('common.edit')}>
        <Button variant="ghost" size="icon-sm" aria-label={t('preview.cars.editAria', { plate: row.plate })} onClick={() => openEditor(row)}>
          <Pencil aria-hidden />
        </Button>
      </Tooltip>
      <Tooltip content={t('common.delete')}>
        <Button
          variant="ghost"
          size="icon-sm"
          className="hover:text-critical"
          aria-label={t('preview.cars.deleteAria', { plate: row.plate })}
          onClick={() => setDeleting(row)}
        >
          <Trash2 aria-hidden />
        </Button>
      </Tooltip>
    </>
  );

  return (
    <>
      <PageHeader
        title={t('nav.cars')}
        description={t('fleet.carsSubtitle')}
        actions={
          <>
            <Button variant="secondary">
              <Download aria-hidden />
              {t('common.exportExcelShort')}
            </Button>
            <Button onClick={() => openEditor(null)}>
              <Plus aria-hidden />
              {t('fleet.addCar')}
            </Button>
          </>
        }
      />

      <Tabs value={filter} onValueChange={value => setFilter(value as Filter)}>
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <TabsList aria-label={t('fleet.tuevStatusColumn')}>
            {FILTERS.map(value => (
              <TabsTrigger key={value} value={value}>
                {filterLabel[value]}
                <Badge tone={FILTER_TONE[value]} className="px-1.5 tabular-nums">
                  {rowsFor(value).length}
                </Badge>
              </TabsTrigger>
            ))}
          </TabsList>
          <p className="pb-2 text-[13px] text-fg-subtle">
            {t('preview.cars.summary', { count: vehicles.length, limit: PREVIEW_CAR_LIMIT })}
          </p>
        </div>

        <div role="status" className="text-sm font-medium text-positive">
          {status ? (
            <p className="mt-4 flex items-center gap-2">
              <CheckCircle2 aria-hidden className="size-4" />
              {status}
            </p>
          ) : null}
        </div>

        {FILTERS.map(value => (
          <TabsContent key={value} value={value} className="mt-4">
            <DataTable
              caption={`${t('nav.cars')}: ${filterLabel[value]}`}
              columns={columns}
              rows={rowsFor(value)}
              getRowId={row => row.id}
              initialSort={{ columnId: 'plate', direction: 'asc' }}
              rowActions={rowActions}
              rowActionsLabel={t('fleet.actions')}
              scrollClassName="max-h-[70dvh]"
              emptyState={
                <EmptyState size="sm" icon={Car} title={t('fleet.noCarsForFilter')} description={t('fleet.noCarsFilterHint')} />
              }
            />
          </TabsContent>
        ))}
      </Tabs>

      <Sheet open={editorOpen} onOpenChange={setEditorOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{editingId ? t('fleet.editCar') : t('fleet.newCar')}</SheetTitle>
            <SheetDescription>{t('preview.cars.formDescription')}</SheetDescription>
          </SheetHeader>
          <SheetBody>
            <form id="vehicle-form" ref={formRef} noValidate onSubmit={handleSubmit} className="grid gap-6">
              <Field label={t('werkstatt.plate')} required error={errors.plate}>
                <Input
                  value={form.plate}
                  onChange={event => update('plate', event.target.value.toUpperCase())}
                  placeholder={t('fleet.kennzeichenPlaceholder')}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>

              <fieldset className="rounded-surface border border-line px-4 pb-4 pt-1">
                <legend className="px-1 text-[13px] font-semibold text-fg">{t('fleet.tuevSection')}</legend>
                <div className="mt-2 grid gap-4">
                  <Field label={t('fleet.tuevValidUntil')} hint={t('fleet.tuevValidUntilHint')}>
                    <div className="flex gap-2">
                      <Input type="date" value={form.tuevValidUntil} onChange={event => update('tuevValidUntil', event.target.value)} />
                      <Tooltip content={t('fleet.renewTuevTooltip')}>
                        <Button variant="secondary" onClick={() => update('tuevValidUntil', plusOneYear(form.tuevValidUntil))}>
                          <RefreshCw aria-hidden />
                          {t('fleet.plusOneYear')}
                        </Button>
                      </Tooltip>
                    </div>
                  </Field>
                  <Field label={t('fleet.lastHu')} hint={t('fleet.lastHuHint')}>
                    <Input type="date" value={form.lastHu} onChange={event => update('lastHu', event.target.value)} />
                  </Field>
                </div>
              </fieldset>

              <fieldset>
                <legend className="text-[13px] font-semibold text-fg">{t('fleet.assignDrivers')}</legend>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <Field label={t('preview.cars.driverOne')}>
                    <Select value={form.driverOne} onValueChange={value => update('driverOne', value)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_DRIVER}>{t('preview.cars.noDriver')}</SelectItem>
                        {PREVIEW_DRIVERS.map(driver => (
                          <SelectItem key={driver.id} value={driver.id}>
                            {driver.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label={t('preview.cars.driverTwo')} error={errors.driverTwo}>
                    <Select value={form.driverTwo} onValueChange={value => update('driverTwo', value)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_DRIVER}>{t('preview.cars.noDriver')}</SelectItem>
                        {PREVIEW_DRIVERS.map(driver => (
                          <SelectItem key={driver.id} value={driver.id}>
                            {driver.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
              </fieldset>
            </form>
          </SheetBody>
          <SheetFooter>
            <SheetClose asChild>
              <Button variant="secondary">{t('common.cancel')}</Button>
            </SheetClose>
            <Button type="submit" form="vehicle-form">
              {t('common.save')}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <Dialog open={deleting !== null} onOpenChange={open => (open ? undefined : setDeleting(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('fleet.deleteCarTitle')}</DialogTitle>
            <DialogDescription>{t('fleet.deleteCarMessage', { kennzeichen: deleting?.plate ?? '' })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">{t('common.cancel')}</Button>
            </DialogClose>
            <Button variant="danger" onClick={confirmDelete}>
              <Trash2 aria-hidden />
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
