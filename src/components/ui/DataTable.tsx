import { useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, ChevronsUpDown, Inbox, RotateCw } from 'lucide-react';
import { useTranslation } from '../../contexts/LanguageContext';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { Skeleton } from './Skeleton';
import { cn } from './cn';
import { formatDate, formatEuro, formatNumber } from './format';
import { sortRows, type SortDirection, type SortValue } from './sortRows';

/**
 * How a column's value is shown. `number` and `currency` are right-aligned with
 * tabular figures so digits line up down the column; `currency` takes the
 * stored euro amount and `date` the stored `YYYY-MM-DD` text.
 */
export type DataTableColumnKind = 'text' | 'number' | 'currency' | 'date';

export interface DataTableColumn<Row> {
  id: string;
  header: ReactNode;
  /** The raw value, used for sorting and, without `cell`, for display. */
  value?: (row: Row) => SortValue;
  /** Custom rendering; sorting still uses `value`. */
  cell?: (row: Row) => ReactNode;
  kind?: DataTableColumnKind;
  sortable?: boolean;
  /** Hide the column on narrower screens, lowest priority first. */
  hideBelow?: 'sm' | 'md' | 'lg';
  className?: string;
}

export interface DataTableSort {
  columnId: string;
  direction: SortDirection;
}

export interface DataTableProps<Row> {
  columns: DataTableColumn<Row>[];
  rows: readonly Row[];
  getRowId: (row: Row) => string;
  /** Names the table for screen readers. */
  caption: string;
  loading?: boolean;
  /** `true` shows the generic message; a string adds detail under it. */
  error?: string | boolean | null;
  onRetry?: () => void;
  /** Replaces the default "no entries" state, e.g. with a call to action. */
  emptyState?: ReactNode;
  initialSort?: DataTableSort;
  rowActions?: (row: Row) => ReactNode;
  rowActionsLabel?: string;
  /** Values for a summary row, keyed by column id. */
  totals?: Partial<Record<string, ReactNode>>;
  density?: 'comfortable' | 'compact';
  className?: string;
  /** Give the scroll area a max height (e.g. `max-h-[28rem]`) to pin the header. */
  scrollClassName?: string;
}

const HIDE_BELOW = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
} as const;

const SKELETON_ROWS = 5;
const SKELETON_WIDTHS = ['w-3/5', 'w-4/5', 'w-2/3', 'w-1/2', 'w-3/4'];

const isNumeric = (kind?: DataTableColumnKind) => kind === 'number' || kind === 'currency';

function formatValue(kind: DataTableColumnKind | undefined, value: Exclude<SortValue, null | undefined>): string {
  switch (kind) {
    case 'currency':
      // formatEuro refuses a non-finite number; a table cell shows it as it is
      // rather than taking the whole screen down.
      return typeof value === 'number' && Number.isFinite(value) ? formatEuro(value) : String(value);
    case 'number':
      return typeof value === 'number' ? formatNumber(value) : String(value);
    case 'date':
      return formatDate(String(value));
    default:
      return String(value);
  }
}

export function DataTable<Row>({
  columns,
  rows,
  getRowId,
  caption,
  loading = false,
  error = null,
  onRetry,
  emptyState,
  initialSort,
  rowActions,
  rowActionsLabel,
  totals,
  density = 'comfortable',
  className,
  scrollClassName,
}: DataTableProps<Row>) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<DataTableSort | undefined>(initialSort);

  const sortedRows = useMemo(() => {
    const column = sort ? columns.find(candidate => candidate.id === sort.columnId) : undefined;
    if (!sort || !column?.value) return rows;
    return sortRows(rows, column.value, sort.direction);
  }, [columns, rows, sort]);

  const columnCount = columns.length + (rowActions ? 1 : 0);
  const cellHeight = density === 'compact' ? 'h-10' : 'h-12';

  const toggleSort = (columnId: string) => {
    setSort(current =>
      current?.columnId === columnId
        ? { columnId, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { columnId, direction: 'asc' },
    );
  };

  const renderCell = (column: DataTableColumn<Row>, row: Row): ReactNode => {
    if (column.cell) return column.cell(row);
    const value = column.value?.(row);
    if (value === null || value === undefined || value === '') {
      return (
        <>
          <span aria-hidden className="text-fg-subtle">-</span>
          <span className="sr-only">{t('ui.table.noValue')}</span>
        </>
      );
    }
    return formatValue(column.kind, value);
  };

  const renderBody = () => {
    if (loading) {
      return Array.from({ length: SKELETON_ROWS }, (_, rowIndex) => (
        <tr key={`skeleton-${rowIndex}`}>
          {columns.map((column, columnIndex) => (
            <td
              key={column.id}
              className={cn('border-b border-line px-4', cellHeight, column.hideBelow && HIDE_BELOW[column.hideBelow])}
            >
              <Skeleton
                className={cn('h-4', SKELETON_WIDTHS[(rowIndex + columnIndex) % SKELETON_WIDTHS.length], isNumeric(column.kind) && 'ml-auto')}
              />
            </td>
          ))}
          {rowActions ? <td className="border-b border-line" /> : null}
        </tr>
      ));
    }

    if (error) {
      return (
        <tr>
          <td colSpan={columnCount}>
            <div role="alert" className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <AlertTriangle aria-hidden className="size-5 text-critical" />
              <p className="text-[15px] font-semibold text-fg">{t('ui.table.errorTitle')}</p>
              {typeof error === 'string' ? <p className="max-w-[52ch] text-sm text-fg-muted">{error}</p> : null}
              {onRetry ? (
                <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
                  <RotateCw aria-hidden />
                  {t('ui.table.retry')}
                </Button>
              ) : null}
            </div>
          </td>
        </tr>
      );
    }

    if (sortedRows.length === 0) {
      return (
        <tr>
          <td colSpan={columnCount}>{emptyState ?? <EmptyState size="sm" icon={Inbox} title={t('ui.table.emptyTitle')} />}</td>
        </tr>
      );
    }

    return sortedRows.map(row => (
      <tr key={getRowId(row)} className="transition-colors hover:bg-sunken/50">
        {columns.map(column => (
          <td
            key={column.id}
            className={cn(
              'border-b border-line px-4 align-middle text-fg',
              cellHeight,
              isNumeric(column.kind) && 'whitespace-nowrap text-right tabular-nums',
              column.kind === 'date' && 'whitespace-nowrap tabular-nums',
              column.hideBelow && HIDE_BELOW[column.hideBelow],
              column.className,
            )}
          >
            {renderCell(column, row)}
          </td>
        ))}
        {rowActions ? (
          <td className={cn('border-b border-line px-2', cellHeight)}>
            <div className="flex items-center justify-end gap-0.5">{rowActions(row)}</div>
          </td>
        ) : null}
      </tr>
    ));
  };

  const showTotals = Boolean(totals) && !loading && !error && sortedRows.length > 0;

  return (
    <div className={cn('overflow-hidden rounded-surface border border-line bg-raised font-ui shadow-raised', className)}>
      {/* Focusable so a keyboard user can scroll a table wider than the screen. */}
      <div
        role="region"
        aria-label={caption}
        tabIndex={0}
        aria-busy={loading || undefined}
        className={cn(
          'overflow-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus',
          scrollClassName,
        )}
      >
        <table className="w-full border-separate border-spacing-0 text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map(column => {
                const active = sort?.columnId === column.id;
                const sortable = column.sortable && Boolean(column.value);
                const SortIcon = !active ? ChevronsUpDown : sort?.direction === 'asc' ? ArrowUp : ArrowDown;
                return (
                  <th
                    key={column.id}
                    scope="col"
                    aria-sort={sortable ? (active ? (sort?.direction === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
                    className={cn(
                      // Separate borders, not collapsed ones: a collapsed border
                      // does not travel with a sticky header cell.
                      'sticky top-0 z-10 h-10 whitespace-nowrap border-b border-line bg-sunken px-4 text-left text-[13px] font-semibold text-fg-muted',
                      isNumeric(column.kind) && 'text-right',
                      column.hideBelow && HIDE_BELOW[column.hideBelow],
                      column.className,
                    )}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column.id)}
                        className={cn(
                          // On a touch screen the sort button fills the 40 px header row
                          // instead of hugging its 20 px of text.
                          'inline-flex items-center gap-1 rounded-sm transition-colors hover:text-fg [@media(pointer:coarse)]:min-h-10',
                          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                          active && 'text-fg',
                        )}
                      >
                        {column.header}
                        <SortIcon aria-hidden className={cn('size-3.5', !active && 'text-fg-subtle')} />
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
              {rowActions ? (
                <th scope="col" className="sticky top-0 z-10 h-10 w-px border-b border-line bg-sunken px-2">
                  <span className="sr-only">{rowActionsLabel}</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className={cn(!showTotals && '[&>tr:last-child>td]:border-b-0')}>{renderBody()}</tbody>
          {showTotals ? (
            <tfoot>
              <tr>
                {columns.map((column, index) => (
                  <td
                    key={column.id}
                    className={cn(
                      'h-11 bg-sunken/60 px-4 font-semibold text-fg',
                      isNumeric(column.kind) && 'whitespace-nowrap text-right tabular-nums',
                      column.hideBelow && HIDE_BELOW[column.hideBelow],
                    )}
                  >
                    {totals?.[column.id] ?? (index === 0 ? t('ui.table.total') : null)}
                  </td>
                ))}
                {rowActions ? <td className="bg-sunken/60" /> : null}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </div>
  );
}
