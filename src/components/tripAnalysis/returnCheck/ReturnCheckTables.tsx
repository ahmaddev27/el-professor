import { Badge, Button, Card, CardContent, CardHeader, CardTitle, DataTable, Field, NativeSelect, formatDate, formatNumber, type DataTableColumn } from '../../ui';
import { useTranslation } from '../../../contexts/LanguageContext';
import {
  ANOMALY_KEYS,
  PLACEMENT_KEYS,
  REVIEW_PLACEMENTS,
  type AnomalyRow,
  type ReviewPlacement,
  type ReviewRow,
} from '../../../utils/returnCheckScreens';

const DASH = '—';

interface ReviewTableProps {
  rows: readonly ReviewRow[];
  totalRows: number;
  /** Rides that could not be checked: with none to review, "nothing to review" would otherwise read as "all fine". */
  unverifiableTotal: number;
  vehicles: readonly string[];
  vehicle: string;
  onVehicle: (vehicle: string) => void;
  placement: '' | ReviewPlacement;
  onPlacement: (placement: '' | ReviewPlacement) => void;
  onExport: () => void;
}

export function ReviewTable({ rows, totalRows, unverifiableTotal, vehicles, vehicle, onVehicle, placement, onPlacement, onExport }: ReviewTableProps) {
  const { t } = useTranslation();
  const columns: DataTableColumn<ReviewRow>[] = [
    {
      id: 'date', header: t('returncheck.col.date'), value: r => r.orderMs,
      cell: r => <span className="tabular-nums">{formatDate(r.date)}</span>,
    },
    { id: 'vehicle', header: t('returncheck.col.vehicle'), value: r => r.vehicle },
    { id: 'driver', header: t('returncheck.col.driver'), hideBelow: 'sm', value: r => r.driver ?? '', cell: r => r.driver ?? DASH },
    { id: 'orderAt', header: t('returncheck.col.orderAt'), value: r => r.orderMs, cell: r => <span className="tabular-nums">{r.orderTime}</span> },
    {
      id: 'previousEnd', header: t('returncheck.col.previousEnd'), hideBelow: 'md', value: r => r.previousEndTime ?? '',
      cell: r => <span className="tabular-nums">{r.previousEndTime ?? DASH}</span>,
    },
    {
      id: 'wait', header: t('returncheck.col.wait'), kind: 'number', value: r => r.waitMinutes,
      cell: r => (r.waitMinutes === null ? DASH : formatNumber(Math.round(r.waitMinutes))),
    },
    {
      id: 'distance', header: t('returncheck.col.distance'), kind: 'number', hideBelow: 'sm', value: r => r.distanceKm,
      cell: r => (r.distanceKm === null ? DASH : formatNumber(r.distanceKm, 1)),
    },
    {
      id: 'hints', header: t('returncheck.col.hints'), hideBelow: 'md',
      cell: r => (
        <span className="flex flex-wrap gap-1">
          {r.placement === 'block_start_away' ? <Badge tone="neutral">{t('returncheck.hint.blockStart')}</Badge> : null}
          {r.prebooked ? <Badge tone="brand">{t('returncheck.hint.prebooked')}</Badge> : null}
          {r.samePostalCode ? <Badge tone="caution">{t('returncheck.hint.samePostalCode')}</Badge> : null}
        </span>
      ),
    },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('returncheck.review.title')}</CardTitle>
        <Button variant="secondary" size="sm" disabled={rows.length === 0} onClick={onExport}>
          {t('returncheck.export.button')}
        </Button>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:max-w-xl">
          <Field label={t('returncheck.review.vehicleFilter')}>
            <NativeSelect value={vehicle} onChange={e => onVehicle(e.target.value)}>
              <option value="">{t('returncheck.review.all')}</option>
              {vehicles.map(v => <option key={v} value={v}>{v}</option>)}
            </NativeSelect>
          </Field>
          <Field label={t('returncheck.review.placementFilter')}>
            <NativeSelect value={placement} onChange={e => onPlacement(e.target.value as '' | ReviewPlacement)}>
              <option value="">{t('returncheck.review.all')}</option>
              {REVIEW_PLACEMENTS.map(p => <option key={p} value={p}>{t(PLACEMENT_KEYS[p])}</option>)}
            </NativeSelect>
          </Field>
        </div>
        <DataTable
          columns={columns}
          rows={rows}
          getRowId={r => r.id}
          caption={t('returncheck.review.caption')}
          initialSort={{ columnId: 'wait', direction: 'desc' }}
          emptyState={
            <p className="py-6 text-center text-sm text-fg-muted">
              {totalRows > 0
                ? t('returncheck.review.emptyFiltered')
                : unverifiableTotal > 0
                  ? t('returncheck.review.emptyButUnverifiable', { count: formatNumber(unverifiableTotal) })
                  : t('returncheck.review.empty')}
            </p>
          }
        />
      </CardContent>
    </Card>
  );
}

export function AnomalyTable({ rows }: { rows: readonly AnomalyRow[] }) {
  const { t } = useTranslation();
  const columns: DataTableColumn<AnomalyRow>[] = [
    {
      id: 'date', header: t('returncheck.col.date'), value: r => r.sortMs,
      cell: r => <span className="tabular-nums">{r.date ? formatDate(r.date) : DASH}</span>,
    },
    { id: 'vehicle', header: t('returncheck.col.vehicle'), value: r => r.vehicle, cell: r => r.vehicle || DASH },
    { id: 'driver', header: t('returncheck.col.driver'), hideBelow: 'sm', value: r => r.driver ?? '', cell: r => r.driver ?? DASH },
    { id: 'type', header: t('returncheck.col.type'), value: r => t(ANOMALY_KEYS[r.type]), cell: r => <Badge tone="caution">{t(ANOMALY_KEYS[r.type])}</Badge> },
    {
      id: 'details', header: t('returncheck.col.details'), className: 'min-w-[12rem]',
      cell: r => (
        <span className="grid grid-cols-1 gap-0.5 break-words text-sm">
          {r.detail ? <span>{t(r.detail.key, r.detail.vars)}</span> : null}
          {r.addresses ? (
            <>
              <span className="text-fg-muted">{t('returncheck.addr.pickup', { text: r.addresses.pickup })}</span>
              <span className="text-fg-muted">{t('returncheck.addr.dropoff', { text: r.addresses.dropoff })}</span>
            </>
          ) : null}
          {!r.detail && !r.addresses ? DASH : null}
        </span>
      ),
    },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('returncheck.anomalies.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <DataTable
          columns={columns}
          rows={rows}
          getRowId={r => r.id}
          caption={t('returncheck.anomalies.caption')}
          initialSort={{ columnId: 'date', direction: 'asc' }}
          emptyState={<p className="py-6 text-center text-sm text-fg-muted">{t('returncheck.anomalies.empty')}</p>}
        />
      </CardContent>
    </Card>
  );
}
