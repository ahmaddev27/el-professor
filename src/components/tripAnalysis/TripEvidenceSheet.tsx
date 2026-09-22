import { useMemo } from 'react';
import { Route } from 'lucide-react';
import {
  DataTable,
  EmptyState,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  type DataTableColumn,
} from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import type { AnalyzedTrip } from '../../utils/tripAnalysis/types';
import { formatBerlinDateTime } from '../../lib/tripAnalysisView';
import { formatTripPrice } from '../../lib/tripAnalysisFormat';
import { EXCLUSION_KEYS } from '../../lib/tripAnalysisLabels';
import { TripStatusBadge } from './TripAnalysisBadges';

export interface TripEvidence {
  /** What the trips are the evidence of, already in words. */
  label: string;
  tripIds: readonly string[];
}

interface Props {
  evidence: TripEvidence | null;
  tripsById: ReadonlyMap<string, AnalyzedTrip>;
  onClose: () => void;
}

/**
 * The trips behind a figure or a finding, as they were imported. Read only:
 * there is no control here, and none anywhere on this screen, that changes a
 * trip.
 */
export function TripEvidenceSheet({ evidence, tripsById, onClose }: Props) {
  const { t } = useTranslation();

  const rows = useMemo(
    () =>
      (evidence?.tripIds ?? [])
        .map(id => tripsById.get(id))
        .filter((analyzed): analyzed is AnalyzedTrip => Boolean(analyzed))
        .sort((a, b) => (a.trip.start_ms ?? Infinity) - (b.trip.start_ms ?? Infinity) || a.trip.id.localeCompare(b.trip.id)),
    [evidence, tripsById],
  );

  const columns: DataTableColumn<AnalyzedTrip>[] = [
    {
      id: 'start',
      header: t('ta.col.start'),
      value: row => row.trip.start_ms,
      className: 'pl-3 pr-2 sm:px-4',
      cell: row => (
        <span className="block py-1 tabular-nums">
          {formatBerlinDateTime(row.trip.start_ms) || '—'}
          <span className="block text-xs text-fg-muted">
            {t('ta.col.row')} {row.trip.source_row ?? '—'}
            {row.trip.vehicle ? ` · ${row.trip.vehicle}` : ''}
          </span>
        </span>
      ),
    },
    {
      id: 'end',
      header: t('ta.col.end'),
      value: row => row.trip.end_ms,
      hideBelow: 'sm',
      cell: row => <span className="tabular-nums">{formatBerlinDateTime(row.trip.end_ms) || '—'}</span>,
    },
    {
      id: 'driver',
      header: t('ta.col.driver'),
      value: row => row.trip.driver_name ?? '',
      className: 'px-2 sm:px-4',
      cell: row => (
        <span className="block py-1">
          {row.trip.driver_name || '—'}
          <span className="mt-1 block">
            <TripStatusBadge status={row.trip.status} />
          </span>
          {row.excludedBecause.length > 0 ? (
            <span className="mt-1 block text-xs text-fg-muted">
              {t('ta.evidence.excluded', { reasons: row.excludedBecause.map(reason => t(EXCLUSION_KEYS[reason])).join(', ') })}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'price',
      header: t('ta.col.price'),
      kind: 'number',
      className: 'pl-2 pr-3 sm:px-4',
      cell: row => (
        <span className="tabular-nums">
          {formatTripPrice(row.trip.price, row.trip.currency) || '—'}
          {row.trip.currency === null && row.trip.price !== null ? (
            <span className="block text-xs text-fg-muted">{t('ta.noCurrency')}</span>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <Sheet open={evidence !== null} onOpenChange={open => (!open ? onClose() : undefined)}>
      <SheetContent side="right" className="sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{t('ta.evidence.title', { label: evidence?.label ?? '' })}</SheetTitle>
          <SheetDescription>{t('ta.evidence.description')}</SheetDescription>
        </SheetHeader>
        <SheetBody className="px-3 sm:px-6">
          <DataTable
            caption={t('ta.evidence.title', { label: evidence?.label ?? '' })}
            columns={columns}
            rows={rows}
            getRowId={row => row.trip.id}
            density="compact"
            emptyState={<EmptyState size="sm" icon={Route} title={t('ta.evidence.empty')} />}
          />
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
