import { useState, type ReactNode } from 'react';
import { Car, Pencil, ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX } from 'lucide-react';
import { useTranslation } from '../../contexts/LanguageContext';
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  Field,
  Input,
  KpiCard,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  formatEuro,
  type DataTableColumn,
} from '../../components/ui';
import { PREVIEW_DRIVERS, PREVIEW_PLAN, PREVIEW_VEHICLES, centsToEuros, type PreviewVehicle } from '../sampleData';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid content-start gap-3">
      <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
      {children}
    </section>
  );
}

export default function ComponentsPreview() {
  const { t } = useTranslation();
  const [amount, setAmount] = useState('');

  const columns: DataTableColumn<PreviewVehicle>[] = [
    { id: 'plate', header: t('werkstatt.plate'), value: row => row.plate, sortable: true },
    { id: 'tuev', header: t('fleet.tuevValidUntil'), kind: 'date', value: row => row.tuevValidUntil, sortable: true },
    {
      id: 'revenue',
      header: t('overview.kpi.umsatz'),
      kind: 'currency',
      value: row => (row.revenueCents === null ? null : centsToEuros(row.revenueCents)),
      sortable: true,
    },
  ];

  const tableStates = [
    { value: 'loading', label: t('common.loading'), props: { rows: [], loading: true } },
    { value: 'empty', label: t('preview.components.empty'), props: { rows: [] } },
    { value: 'error', label: t('common.error'), props: { rows: [], error: t('overview.error.partial'), onRetry: () => undefined } },
    { value: 'data', label: t('nav.cars'), props: { rows: PREVIEW_VEHICLES.slice(0, 4) } },
  ];

  return (
    <>
      <PageHeader title={t('preview.nav.components')} description={t('preview.components.description')} />

      <div className="grid gap-10">
        <div className="grid gap-10 lg:grid-cols-2">
          <Section title={t('preview.components.buttons')}>
            <div className="flex flex-wrap items-center gap-2">
              <Button>{t('common.save')}</Button>
              <Button variant="secondary">{t('common.cancel')}</Button>
              <Button variant="ghost">{t('common.edit')}</Button>
              <Button variant="danger">{t('common.delete')}</Button>
              <Button variant="link">{t('preview.fleet.viewAll')}</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm">{t('common.save')}</Button>
              <Button size="lg">{t('common.save')}</Button>
              <Button loading>{t('common.saving')}</Button>
              <Button disabled>{t('common.save')}</Button>
              <Tooltip content={t('preview.components.tooltip')}>
                <Button variant="secondary" size="icon" aria-label={t('common.edit')}>
                  <Pencil aria-hidden />
                </Button>
              </Tooltip>
            </div>
          </Section>

          <Section title={t('preview.components.badges')}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="positive">
                <ShieldCheck aria-hidden />
                {t('fleet.tuevStatus.valid')}
              </Badge>
              <Badge tone="caution">
                <ShieldAlert aria-hidden />
                {t('fleet.tuevStatus.expiringSoon')}
              </Badge>
              <Badge tone="critical">
                <ShieldX aria-hidden />
                {t('fleet.tuevStatus.expired')}
              </Badge>
              <Badge tone="neutral">
                <ShieldQuestion aria-hidden />
                {t('fleet.tuevStatus.unknown')}
              </Badge>
              <Badge tone="brand">{PREVIEW_PLAN}</Badge>
            </div>
          </Section>
        </div>

        <Section title={t('preview.components.forms')}>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Field label={t('common.amount')} hint={t('preview.components.amountHint')}>
              <Input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder="0,00" />
            </Field>
            <Field label={t('common.amount')} required error={t('preview.components.amountError')}>
              <Input inputMode="decimal" defaultValue="0,00" />
            </Field>
            <Field label={t('common.driver')}>
              <Select defaultValue={PREVIEW_DRIVERS[0].id}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PREVIEW_DRIVERS.slice(0, 8).map(driver => (
                    <SelectItem key={driver.id} value={driver.id}>
                      {driver.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('common.date')}>
              <Input type="date" defaultValue="2026-09-14" disabled />
            </Field>
          </div>
        </Section>

        <Section title={t('preview.components.kpis')}>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label={t('overview.kpi.umsatz')}
              value={formatEuro(104432.8)}
              trend={{ direction: 'up', value: '+6,8 %', label: t('overview.kpi.vsPrevMonth'), sentiment: 'positive' }}
            />
            <KpiCard
              label={t('overview.kpi.gesamtkosten')}
              value={formatEuro(21286.45)}
              trend={{ direction: 'down', value: '-3,7 %', label: t('overview.kpi.vsPrevMonth'), sentiment: 'positive' }}
            />
            <KpiCard label={t('overview.kpi.bargeld')} value={formatEuro(0)} loading />
          </div>
        </Section>

        <Section title={t('preview.components.tables')}>
          <Tabs defaultValue="loading">
            <TabsList variant="segmented" aria-label={t('preview.components.tables')}>
              {tableStates.map(state => (
                <TabsTrigger key={state.value} value={state.value}>
                  {state.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {tableStates.map(state => (
              <TabsContent key={state.value} value={state.value} className="mt-3">
                <DataTable
                  caption={`${t('preview.components.tables')}: ${state.label}`}
                  columns={columns}
                  getRowId={row => row.id}
                  emptyState={
                    state.value === 'empty' ? (
                      <EmptyState size="sm" icon={Car} title={t('fleet.noCars')} description={t('fleet.noCarsHint')} />
                    ) : undefined
                  }
                  {...state.props}
                />
              </TabsContent>
            ))}
          </Tabs>
        </Section>

        <Section title={t('preview.components.overlays')}>
          <div className="flex flex-wrap items-center gap-2">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="secondary">{t('preview.components.openDialog')}</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t('fleet.deleteCarTitle')}</DialogTitle>
                  <DialogDescription>{t('fleet.deleteCarMessage', { kennzeichen: PREVIEW_VEHICLES[0].plate })}</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="secondary">{t('common.cancel')}</Button>
                  </DialogClose>
                  <DialogClose asChild>
                    <Button variant="danger">{t('common.delete')}</Button>
                  </DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="secondary">{t('preview.components.openSheet')}</Button>
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>{t('fleet.newCar')}</SheetTitle>
                  <SheetDescription>{t('preview.cars.formDescription')}</SheetDescription>
                </SheetHeader>
                <SheetBody>
                  <EmptyState icon={Car} title={t('preview.missing.title')} description={t('preview.missing.body')} />
                </SheetBody>
              </SheetContent>
            </Sheet>
          </div>
        </Section>
      </div>
    </>
  );
}
