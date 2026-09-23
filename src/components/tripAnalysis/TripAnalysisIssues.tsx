import { useMemo, useState } from 'react';
import { Filter } from 'lucide-react';
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  formatNumber,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsTrigger,
  type DataTableColumn,
} from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import type { TranslationKey, TranslationVars } from '../../i18n';
import type { Issue, IssueSeverity, IssueStatus, IssueType } from '../../utils/tripAnalysis/types';
import { filterIssues, issueStatusCounts, issueTypesPresent } from '../../lib/tripAnalysisView';
import { formatMinutes } from '../../lib/tripAnalysisFormat';
import { ISSUE_SEVERITY_KEYS, ISSUE_STATUS_KEYS, ISSUE_TYPE_KEYS } from '../../lib/tripAnalysisLabels';
import { IssueStatusBadge, SeverityBadge } from './TripAnalysisBadges';
import type { TripEvidence } from './TripEvidenceSheet';

type Translate = (key: TranslationKey, vars?: TranslationVars) => string;

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * One line of words from a finding's type and its values, in the UI language.
 * The engine's own explanation is German; the German screen shows it too.
 */
export function issueDetail(t: Translate, issue: Issue): string | null {
  const minutes = (value: number | null) => (value === null ? null : t('ta.minutes', { value: formatMinutes(value) }));
  const v = issue.values;
  switch (issue.type) {
    case 'driver_overlap':
    case 'vehicle_overlap':
    case 'shift_overlap': {
      const m = minutes(num(v.overlapMinutes));
      return m ? t('ta.detail.overlap', { minutes: m }) : null;
    }
    case 'travel_gap': {
      const available = minutes(num(v.availableMinutes));
      const margin = minutes(num(v.marginMinutes));
      if (!available || !margin) return null;
      // The finding covers every consecutive pair, so most gaps are long ones
      // the engine simply could not check. Only the short ones are named short.
      return t(v.belowMargin === true ? 'ta.detail.travelShort' : 'ta.detail.travel', { available, margin });
    }
    case 'activity_outside_shift': {
      const m = minutes(num(v.outsideMinutes));
      return m ? t('ta.detail.outside', { minutes: m }) : null;
    }
    case 'shift_without_activity': {
      const m = minutes(num(v.shiftMinutes));
      return m ? t('ta.detail.shiftIdle', { minutes: m }) : null;
    }
    case 'activity_over_budget':
    case 'shifts_over_budget': {
      const m = minutes(num(v.overByMinutes));
      return m ? t('ta.detail.over', { minutes: m }) : null;
    }
    default:
      return null;
  }
}

interface Props {
  issues: readonly Issue[];
  driverNames: ReadonlyMap<string, string>;
  onShowTrips: (evidence: TripEvidence) => void;
  /** Hides the driver column and names the list as one driver's. */
  singleDriver?: boolean;
}

const STATUS_ORDER: Array<IssueStatus | 'all'> = ['all', 'conflict', 'unverifiable', 'passed'];
const SEVERITIES: IssueSeverity[] = ['error', 'warning', 'info'];

export function TripAnalysisIssues({ issues, driverNames, onShowTrips, singleDriver = false }: Props) {
  const { t, tPlural, language } = useTranslation();
  const [type, setType] = useState<IssueType | 'all'>('all');
  const [severity, setSeverity] = useState<IssueSeverity | 'all'>('all');
  const [status, setStatus] = useState<IssueStatus | 'all'>('all');

  const types = useMemo(() => issueTypesPresent(issues), [issues]);
  const counts = useMemo(() => issueStatusCounts(issues), [issues]);
  const rows = useMemo(() => filterIssues(issues, { type, severity, status }), [issues, type, severity, status]);

  const columns: DataTableColumn<Issue>[] = [
    {
      id: 'finding',
      header: t('ta.col.finding'),
      value: issue => t(ISSUE_TYPE_KEYS[issue.type]),
      sortable: true,
      className: 'pl-3 pr-2 sm:px-4',
      cell: issue => {
        const detail = issueDetail(t, issue);
        return (
          <span className="block min-w-[12rem] py-1.5">
            <span className="block font-semibold text-fg">{t(ISSUE_TYPE_KEYS[issue.type])}</span>
            {detail ? <span className="block text-xs text-fg-muted">{detail}</span> : null}
            {language === 'de' && issue.explanation ? (
              <span className="block text-xs text-fg-muted">{issue.explanation}</span>
            ) : null}
            <span className="mt-1 flex flex-wrap gap-1 sm:hidden">
              <IssueStatusBadge status={issue.status} />
            </span>
          </span>
        );
      },
    },
    ...(singleDriver
      ? []
      : [
          {
            id: 'driver',
            header: t('ta.col.driver'),
            hideBelow: 'md' as const,
            value: (issue: Issue) => (issue.driverId ? driverNames.get(issue.driverId) ?? issue.driverId : ''),
            sortable: true,
          },
        ]),
    {
      id: 'status',
      header: t('ta.col.status'),
      hideBelow: 'sm',
      value: issue => issue.status,
      sortable: true,
      cell: issue => <IssueStatusBadge status={issue.status} />,
    },
    {
      id: 'severity',
      header: t('ta.col.severity'),
      hideBelow: 'lg',
      value: issue => SEVERITIES.indexOf(issue.severity),
      sortable: true,
      cell: issue => <SeverityBadge severity={issue.severity} />,
    },
    {
      id: 'evidence',
      header: t('ta.col.evidence'),
      className: 'pl-2 pr-3 sm:px-4',
      cell: issue =>
        issue.tripIds.length === 0 ? (
          <span className="text-fg-subtle">—</span>
        ) : (
          <Button
            variant="link"
            className="whitespace-nowrap"
            onClick={() => onShowTrips({ label: t(ISSUE_TYPE_KEYS[issue.type]), tripIds: issue.tripIds })}
          >
            {tPlural({ one: 'ta.trips.one', other: 'ta.trips.other' }, issue.tripIds.length)}
          </Button>
        ),
    },
  ];

  return (
    <section aria-labelledby="ta-issues" className="grid grid-cols-1 gap-3">
      <h2 id="ta-issues" className="text-[15px] font-semibold text-fg">
        {singleDriver ? t('ta.issues.driverOnly') : t('ta.issues.title')}
      </h2>

      <Card className="grid grid-cols-1 gap-4 p-4">
        <Tabs value={status} onValueChange={value => setStatus(value as IssueStatus | 'all')}>
          <TabsList variant="segmented" aria-label={t('ta.filter.status')}>
            {STATUS_ORDER.map(option => (
              <TabsTrigger key={option} value={option}>
                {option === 'all'
                  ? t('ta.statusCount', { label: t('ta.filter.all'), count: formatNumber(issues.length) })
                  : t('ta.statusCount', { label: t(ISSUE_STATUS_KEYS[option]), count: formatNumber(counts[option]) })}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('ta.filter.type')}>
            <Select value={type} onValueChange={value => setType(value as IssueType | 'all')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('ta.filter.allTypes')}</SelectItem>
                {types.map(option => (
                  <SelectItem key={option} value={option}>
                    {t(ISSUE_TYPE_KEYS[option])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('ta.filter.severity')}>
            <Select value={severity} onValueChange={value => setSeverity(value as IssueSeverity | 'all')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('ta.filter.allSeverities')}</SelectItem>
                {SEVERITIES.map(option => (
                  <SelectItem key={option} value={option}>
                    {t(ISSUE_SEVERITY_KEYS[option])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      </Card>

      {/* Every finding stays in the list — the travel check reports one per
          consecutive pair, so a month of a hundred rides has a hundred of
          them — but the list scrolls inside a pinned header rather than
          making the page ten screens long.

          `contain:paint` is not decoration. Measured in Chrome 141: with the
          max-height alone, `document.body.scrollHeight` was the correct 1237
          while `document.documentElement.scrollHeight` was 8592 and the page
          really scrolled that far, so the reader got seven screens of empty
          background under a table that was already clipped — the sticky
          header's layout overflow escaping the scroll container. Containment
          makes the container a containing block and the root measures 1237,
          with the sticky header still pinned. The same would happen on any
          DataTable given `scrollClassName` and enough rows. */}
      <DataTable
        caption={t('ta.issues.title')}
        columns={columns}
        rows={rows}
        getRowId={issue => issue.id}
        scrollClassName="max-h-[32rem] [contain:paint]"
        emptyState={<EmptyState size="sm" icon={Filter} title={t('ta.issues.empty')} />}
      />
    </section>
  );
}
