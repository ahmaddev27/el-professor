import React, { useCallback, useEffect, useState } from 'react';
import {
  Car, Users, User, RefreshCw, Search, ShieldAlert, ChevronLeft, ChevronRight, Download, Ban, CheckCircle2,
} from 'lucide-react';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import {
  DIRECTORY_PAGE_SIZE,
  DRIVER_SORTS,
  USER_SORTS,
  VEHICLE_SORTS,
  directoryHasNextPage,
  directoryReachablePageCount,
  platformReadRefusalKey,
  type DirectoryQuery,
  type PlatformCompanyRow,
  type PlatformDriverRow,
  type PlatformReadResult,
  type PlatformUserRow,
  type PlatformVehicleRow,
} from '../lib/platformReadModels';
import { fetchCompanies, fetchDrivers, fetchUsers, fetchVehicles } from '../lib/platformDirectoryClient';
import { EMPTY_CELL, deCount, deDate } from '../lib/platformFormat';
import { useColumnPickerExport } from '../contexts/ExportPickerContext';
import {
  buildDirectoryExport,
  type DirectoryExportLabels,
  type FilterEntry,
  type PageScope,
} from '../lib/panelExports';
import { useExportChrome } from '../hooks/useExportChrome';
import { useToast } from '../contexts/ToastContext';
import {
  Alert, Badge, Button, EmptyState, Input, NativeSelect, PageHeader, Tabs, TabsList, TabsTrigger,
} from '../components/ui';

/**
 * Verzeichnisse — vehicles, drivers and users across every company (plan 3.G).
 *
 * Reads only through the audited read models: `platform_vehicles_list`,
 * `platform_drivers_list` and `platform_users_list`, each of which needs
 * `business.read`, writes one audit row per call, and returns **deliberately
 * reduced columns** — no salary, no bank data, no personal identifier beyond
 * the name, and no account that has a platform staff row. Adding a column here
 * is a data protection decision that starts with a migration.
 *
 * Search, filtering, sorting and paging all happen in the database. Filtering
 * the hundred rows of one page in the browser and calling it search would
 * quietly answer a different question than the one that was asked.
 *
 * The sidebar hides this entry for a role without `business.read`; that is a
 * courtesy. This page checks again, and the database checks every call.
 */

type Tab = 'vehicles' | 'drivers' | 'users';

const TABS: { id: Tab; icon: React.ElementType; labelKey: TranslationKey }[] = [
  { id: 'vehicles', icon: Car,    labelKey: 'admin.dir.tab.vehicles' },
  { id: 'drivers',  icon: User,   labelKey: 'admin.dir.tab.drivers' },
  { id: 'users',    icon: Users,  labelKey: 'admin.dir.tab.users' },
];

// The values the database accepts. A sort it does not know is refused with
// 22023 before anything is read, so these lists follow migration 20260916140000.
const SORT_LABELS: Record<string, TranslationKey> = {
  kennzeichen_asc:      'admin.dir.sort.kennzeichenAsc',
  kennzeichen_desc:     'admin.dir.sort.kennzeichenDesc',
  name_asc:             'admin.dir.sort.nameAsc',
  name_desc:            'admin.dir.sort.nameDesc',
  email_asc:            'admin.dir.sort.emailAsc',
  email_desc:           'admin.dir.sort.emailDesc',
  full_name_asc:        'admin.dir.sort.fullNameAsc',
  created_at_desc:      'admin.dir.sort.createdDesc',
  created_at_asc:       'admin.dir.sort.createdAsc',
  tuev_gueltig_bis_asc: 'admin.dir.sort.tuevAsc',
  last_sign_in_at_desc: 'admin.dir.sort.lastSignInDesc',
  company_name_asc:     'admin.dir.sort.companyAsc',
};

// Statuses the product actually stores. A value no row carries simply finds
// nothing — platform_read_token accepts any lower-case token — so the lists
// stay short rather than inventing states.
const STATUS_OPTIONS: Record<Tab, { value: string; labelKey: TranslationKey }[]> = {
  vehicles: [
    { value: 'active',   labelKey: 'admin.dir.status.active' },
    { value: 'inactive', labelKey: 'admin.dir.status.inactive' },
  ],
  drivers: [
    { value: 'active',   labelKey: 'admin.dir.status.active' },
    { value: 'inactive', labelKey: 'admin.dir.status.inactive' },
  ],
  users: [
    { value: 'active',         labelKey: 'admin.dir.status.active' },
    { value: 'pending_invite', labelKey: 'admin.dir.status.pendingInvite' },
    { value: 'inactive',       labelKey: 'admin.dir.status.inactive' },
  ],
};

const DEFAULT_SORT: Record<Tab, string> = {
  vehicles: 'kennzeichen_asc',
  drivers: 'name_asc',
  users: 'created_at_desc',
};

const SORTS: Record<Tab, readonly string[]> = {
  vehicles: VEHICLE_SORTS,
  drivers: DRIVER_SORTS,
  users: USER_SORTS,
};

const SEARCH_PLACEHOLDERS: Record<Tab, TranslationKey> = {
  vehicles: 'admin.dir.searchVehicles',
  drivers: 'admin.dir.searchDrivers',
  users: 'admin.dir.searchUsers',
};

type AnyRow = PlatformVehicleRow | PlatformDriverRow | PlatformUserRow;

const PlatformDirectoriesPage: React.FC = () => {
  const { platformCan } = useSuperAdmin();
  const { t } = useTranslation();
  const exportPicker = useColumnPickerExport();
  const { showToast } = useToast();
  const exportChrome = useExportChrome();
  const canRead = platformCan('business.read');

  const [tab, setTab] = useState<Tab>('vehicles');
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState<DirectoryQuery>({
    companyId: null, search: '', status: null, sort: DEFAULT_SORT.vehicles, pageIndex: 0,
  });

  const [rows, setRows] = useState<AnyRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  /** A refusal the database decided, or a failure; both must read as a sentence. */
  const [problem, setProblem] = useState<TranslationKey | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const [companies, setCompanies] = useState<PlatformCompanyRow[]>([]);
  const [companiesTotal, setCompaniesTotal] = useState(0);

  // The company picker is a convenience read once per screen: every call writes
  // an audit row, so it is not reloaded per keystroke or per tab.
  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    fetchCompanies().then(
      result => {
        if (cancelled || !result.ok) return;
        setCompanies(result.items);
        setCompaniesTotal(result.total);
      },
      () => { /* The picker stays empty; the directories still work. */ },
    );
    return () => { cancelled = true; };
  }, [canRead]);

  const load = useCallback(async (which: Tab, q: DirectoryQuery) => {
    setLoading(true);
    setProblem(null);
    setFailure(null);
    try {
      const fetcher = which === 'vehicles' ? fetchVehicles : which === 'drivers' ? fetchDrivers : fetchUsers;
      const result: PlatformReadResult<AnyRow> = await fetcher(q);
      if (!result.ok) {
        setRows([]);
        setTotal(0);
        setProblem(platformReadRefusalKey(result.reason));
        return;
      }
      setRows(result.items);
      setTotal(result.total);
    } catch (err) {
      setRows([]);
      setTotal(0);
      setProblem('admin.read.failed');
      setFailure(err instanceof Error ? err.message : null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canRead) return;
    void load(tab, query);
  }, [canRead, tab, query, load]);

  const switchTab = (next: Tab) => {
    setTab(next);
    setSearchInput('');
    setQuery({ companyId: null, search: '', status: null, sort: DEFAULT_SORT[next], pageIndex: 0 });
  };

  // Every filter change starts again at page one: page 4 of a different filter
  // is a different set of rows.
  const change = (patch: Partial<DirectoryQuery>) =>
    setQuery(previous => ({ ...previous, ...patch, pageIndex: 0 }));

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    change({ search: searchInput });
  };

  /**
   * The tab on screen as a workbook — one file per tab, because the three carry
   * different columns.
   *
   * **The rule being preserved: an export adds no column the read model
   * withholds.** These three models return deliberately reduced rows — no
   * salary, no bank data, no personal identifier beyond the name, and no account
   * that has a `platform_staff` row — and the builder can only reach what the row
   * types carry. `admin.dir.reducedNote`, the sentence already shown above the
   * tabs, travels into the file's filter band so a spreadsheet read away from the
   * panel says why a column is missing.
   *
   * **And a file says what it holds.** The read models cap a page at 100 rows and
   * write one audited `read` row per call, so this writes the page on screen and
   * says "Seite N von M" in the band and `_seite-N` in the filename (decision
   * D-C). Reading every page to fill one file would put one audit row per page
   * into an append-only log for a convenience.
   */
  const exportLabels = (): DirectoryExportLabels => ({
    sheetTitle: t(TABS.find(entry => entry.id === tab)?.labelKey ?? 'admin.dir.title'),
    company: t('admin.dir.col.company'),
    status: t('admin.dir.col.status'),
    created: t('admin.dir.col.created'),
    kennzeichen: t('admin.dir.col.kennzeichen'),
    tuev: t('admin.dir.col.tuev'),
    lastHu: t('admin.dir.col.lastHu'),
    name: t('admin.dir.col.name'),
    usage: t('admin.dir.col.usage'),
    email: t('admin.dir.col.email'),
    fullName: t('admin.dir.col.fullName'),
    role: t('admin.dir.col.role'),
    confirmed: t('admin.dir.col.confirmed'),
    lastSignIn: t('admin.dir.col.lastSignIn'),
    // Every status the three tabs offer, so a row of one tab is named on any
    // file. A stored value none of them lists is written verbatim by the
    // builder, exactly as `StatusPill` prints it.
    statusNames: Object.fromEntries(
      Object.values(STATUS_OPTIONS)
        .flat()
        .map((option): [string, string] => [option.value, t(option.labelKey)]),
    ),
    scope: { whole: t('admin.export.scope.whole'), page: t('admin.export.scope.page') },
    reducedNote: t('admin.dir.reducedNote'),
    chrome: exportChrome,
  });

  const exportFilters = (): FilterEntry[] => {
    // Only the filters actually applied are listed; `filterBand` drops a null.
    const statusOption = STATUS_OPTIONS[tab].find(option => option.value === query.status);
    return [
      { label: t('admin.dir.export.filterSearch'), value: query.search || null },
      {
        label: t('admin.dir.col.company'),
        value: query.companyId
          ? companies.find(company => company.id === query.companyId)?.name ?? query.companyId
          : null,
      },
      {
        label: t('admin.dir.export.filterStatus'),
        value: query.status ? (statusOption ? t(statusOption.labelKey) : query.status) : null,
      },
      { label: t('admin.dir.export.filterSort'), value: t(SORT_LABELS[query.sort]) },
    ];
  };

  const handleExport = () => {
    try {
      const scope: PageScope = { pageIndex: query.pageIndex, total, rowCount: rows.length };
      const shared = { scope, filters: exportFilters(), filterLineTemplate: t('ui.export.filterLine'), labels: exportLabels() };
      // Three explicit calls: the builder's input is a discriminated union, and
      // widening it to pass `tab` as a variable would need the one cast this
      // whole seam is written without.
      exportPicker.table(
        `platformDirectory:${tab}`,
        tab === 'vehicles'
          ? buildDirectoryExport({ ...shared, tab: 'vehicles', rows: rows as PlatformVehicleRow[] })
          : tab === 'drivers'
            ? buildDirectoryExport({ ...shared, tab: 'drivers', rows: rows as PlatformDriverRow[] })
            : buildDirectoryExport({ ...shared, tab: 'users', rows: rows as PlatformUserRow[] }),
      );
    } catch (error: any) {
      showToast('error', t('ui.export.failed'), error?.message);
    }
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the screen's logic; below, markup only draws.

  if (!canRead) {
    return (
      <div className="glass-card rounded-surface">
        <EmptyState
          icon={ShieldAlert}
          title={t('admin.read.denied')}
          description={t('admin.dir.noAccessBody')}
          className="py-16"
        />
      </div>
    );
  }

  // The pages that can actually be opened, not the pages the rows fill: past
  // the offset ceiling the database refuses the call, so a larger number here
  // would advertise pages the Weiter button correctly declines to reach.
  const pages = directoryReachablePageCount(total);
  const hasNext = directoryHasNextPage(query.pageIndex, total);

  return (
    <div className="space-y-6 font-ui">
      <PageHeader
        title={t('admin.dir.title')}
        description={t('admin.dir.subtitle')}
        className="pb-0"
        actions={(
          <>
            {/* Withheld while the read failed or is running, and while the page is
                empty: a directory file of nought rows is a claim about a customer's
                fleet. */}
            <Button
              variant="secondary"
              disabled={loading || problem !== null || rows.length === 0}
              onClick={handleExport}
              title={t('common.exportExcel')}
            >
              <Download size={14} />{t('admin.export.download')}
            </Button>
            <Button variant="secondary" onClick={() => void load(tab, query)}>
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />{t('admin.common.refresh')}
            </Button>
          </>
        )}
      />

      {/* Why these columns and no others. */}
      <Alert tone="neutral" role="note">{t('admin.dir.reducedNote')}</Alert>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={id => switchTab(id as Tab)}>
        <TabsList variant="segmented" className="flex w-full flex-wrap">
          {TABS.map(({ id, icon: Icon, labelKey }) => (
            <TabsTrigger
              key={id}
              value={id}
              className="flex-1 justify-center"
            >
              <Icon size={15} />{t(labelKey)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Filters — all of them applied by the database */}
      <div className="flex flex-wrap items-center gap-3">
        <form onSubmit={submitSearch} className="relative flex min-w-[220px] flex-1 gap-2">
          <div className="relative flex-1">
            <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-fg-subtle" />
            <Input
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder={t(SEARCH_PLACEHOLDERS[tab])}
              maxLength={100}
              className="pl-8"
            />
          </div>
          <Button type="submit">{t('admin.common.search')}</Button>
        </form>

        <NativeSelect
          containerClassName="w-auto"
          value={query.companyId ?? ''}
          onChange={e => change({ companyId: e.target.value || null })}
        >
          <option value="">{t('admin.common.allCompanies')}</option>
          {companies.map(company => (
            <option key={company.id} value={company.id}>{company.name}</option>
          ))}
        </NativeSelect>

        <NativeSelect
          containerClassName="w-auto"
          value={query.status ?? ''}
          onChange={e => change({ status: e.target.value || null })}
        >
          <option value="">{t('admin.common.allStatuses')}</option>
          {STATUS_OPTIONS[tab].map(option => (
            <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
          ))}
        </NativeSelect>

        <NativeSelect containerClassName="w-auto" value={query.sort} onChange={e => change({ sort: e.target.value })}>
          {SORTS[tab].map(sort => (
            <option key={sort} value={sort}>{t(SORT_LABELS[sort])}</option>
          ))}
        </NativeSelect>
      </div>

      {companiesTotal > companies.length && (
        <p className="text-xs text-fg-subtle">
          {t('admin.dir.companyLimitNote', { shown: deCount(companies.length), total: deCount(companiesTotal) })}
        </p>
      )}

      {/* Rows */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <RefreshCw size={24} className="animate-spin text-fg-subtle" />
        </div>
      ) : problem ? (
        <div className="glass-card rounded-surface">
          <EmptyState icon={ShieldAlert} title={t(problem)} description={failure ?? undefined} className="py-14" />
        </div>
      ) : rows.length === 0 ? (
        <div className="glass-card rounded-surface">
          <EmptyState title={t('admin.dir.empty')} className="py-14" />
        </div>
      ) : (
        /* A table stays a table on a phone; only it scrolls, never the page. */
        <div className="glass-card relative overflow-x-auto rounded-surface">
          {tab === 'vehicles' && <VehicleTable rows={rows as PlatformVehicleRow[]} />}
          {tab === 'drivers' && <DriverTable rows={rows as PlatformDriverRow[]} />}
          {tab === 'users' && <UserTable rows={rows as PlatformUserRow[]} />}
        </div>
      )}

      {/* Paging — server side, and never past the offset the database serves */}
      {!loading && !problem && rows.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs tabular-nums text-fg-subtle">
            {t('admin.common.totalRows', { total: deCount(total), size: deCount(DIRECTORY_PAGE_SIZE) })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => setQuery(q => ({ ...q, pageIndex: Math.max(0, q.pageIndex - 1) }))}
              disabled={query.pageIndex === 0}
            >
              <ChevronLeft size={14} />{t('admin.common.prev')}
            </Button>
            <span className="whitespace-nowrap text-xs tabular-nums text-fg-muted">
              {t('admin.common.pageOf', { page: deCount(query.pageIndex + 1), pages: deCount(pages) })}
            </span>
            <Button
              variant="secondary"
              onClick={() => setQuery(q => ({ ...q, pageIndex: q.pageIndex + 1 }))}
              disabled={!hasNext}
            >
              {t('admin.common.next')}<ChevronRight size={14} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── The three tables ───────────────────────────────────────────────────────

const StatusPill: React.FC<{ status: string | null }> = ({ status }) => {
  if (!status) return <span className="text-fg-subtle">{EMPTY_CELL}</span>;
  const inactive = status === 'inactive' || status === 'blocked';
  return (
    <Badge tone={inactive ? 'neutral' : 'positive'}>
      {inactive ? <Ban aria-hidden /> : <CheckCircle2 aria-hidden />}
      {status}
    </Badge>
  );
};

const Th: React.FC<{ labelKey: TranslationKey }> = ({ labelKey }) => {
  const { t } = useTranslation();
  return (
    <th className="whitespace-nowrap px-5 py-3.5 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">
      {t(labelKey)}
    </th>
  );
};

const HEAD_ROW = 'border-b border-line bg-wash';
const BODY_ROW = 'border-b border-line last:border-b-0';
const CELL = 'px-5 py-4 text-fg-muted';
const DATE_CELL = 'whitespace-nowrap px-5 py-4 text-xs tabular-nums text-fg-subtle';

const CompanyCell: React.FC<{ name: string | null }> = ({ name }) => (
  <td className="px-5 py-4 text-xs text-fg-subtle">{name || EMPTY_CELL}</td>
);

const VehicleTable: React.FC<{ rows: PlatformVehicleRow[] }> = ({ rows }) => (
  <table className="w-full text-sm">
    <thead>
      <tr className={HEAD_ROW}>
        <Th labelKey="admin.dir.col.kennzeichen" />
        <Th labelKey="admin.dir.col.company" />
        <Th labelKey="admin.dir.col.status" />
        <Th labelKey="admin.dir.col.tuev" />
        <Th labelKey="admin.dir.col.lastHu" />
        <Th labelKey="admin.dir.col.created" />
      </tr>
    </thead>
    <tbody>
      {rows.map(row => (
        <tr key={row.id} className={BODY_ROW}>
          <td className="px-5 py-4 font-semibold text-fg">{row.kennzeichen || EMPTY_CELL}</td>
          <CompanyCell name={row.company_name} />
          <td className="px-5 py-4"><StatusPill status={row.status} /></td>
          <td className={`${CELL} whitespace-nowrap tabular-nums`}>{deDate(row.tuev_gueltig_bis)}</td>
          <td className={`${CELL} whitespace-nowrap tabular-nums`}>{deDate(row.letzte_hu)}</td>
          <td className={DATE_CELL}>{deDate(row.created_at)}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

const DriverTable: React.FC<{ rows: PlatformDriverRow[] }> = ({ rows }) => (
  <table className="w-full text-sm">
    <thead>
      <tr className={HEAD_ROW}>
        <Th labelKey="admin.dir.col.name" />
        <Th labelKey="admin.dir.col.company" />
        <Th labelKey="admin.dir.col.status" />
        <Th labelKey="admin.dir.col.usage" />
        <Th labelKey="admin.dir.col.created" />
      </tr>
    </thead>
    <tbody>
      {rows.map(row => (
        <tr key={row.id} className={BODY_ROW}>
          <td className="px-5 py-4 font-semibold text-fg">{row.name || EMPTY_CELL}</td>
          <CompanyCell name={row.company_name} />
          <td className="px-5 py-4"><StatusPill status={row.status} /></td>
          <td className={CELL}>{row.driver_usage_type || EMPTY_CELL}</td>
          <td className={DATE_CELL}>{deDate(row.created_at)}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

const UserTable: React.FC<{ rows: PlatformUserRow[] }> = ({ rows }) => (
  <table className="w-full text-sm">
    <thead>
      <tr className={HEAD_ROW}>
        <Th labelKey="admin.dir.col.email" />
        <Th labelKey="admin.dir.col.fullName" />
        <Th labelKey="admin.dir.col.company" />
        <Th labelKey="admin.dir.col.role" />
        <Th labelKey="admin.dir.col.status" />
        <Th labelKey="admin.dir.col.confirmed" />
        <Th labelKey="admin.dir.col.lastSignIn" />
      </tr>
    </thead>
    <tbody>
      {rows.map(row => (
        <tr key={row.user_id} className={BODY_ROW}>
          <td className="px-5 py-4 font-semibold text-fg">{row.email || EMPTY_CELL}</td>
          <td className={CELL}>{row.full_name || EMPTY_CELL}</td>
          <CompanyCell name={row.company_name} />
          <td className={CELL}>{row.role_name || row.role || EMPTY_CELL}</td>
          <td className="px-5 py-4"><StatusPill status={row.status} /></td>
          <td className={DATE_CELL}>{deDate(row.email_confirmed_at)}</td>
          <td className={DATE_CELL}>{deDate(row.last_sign_in_at)}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

export default PlatformDirectoriesPage;
